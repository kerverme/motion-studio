"""Selected audio -> approved ASR -> immutable dialogue in both prompt versions.

Sol sees frames; GPT-Transcribe hears only the selected WAV. Its output has no
word timestamps or speaker labels. Never invent either from image observations.
"""
import copy
import datetime as dt
import json
import os
import wave
from pathlib import Path

import requests
from psycopg.types.json import Jsonb
from .creative_ledger import Ledger
from .reverse_media import fetch_private, save_private, file_sha
from .reverse_provider import fingerprint
from .reverse_render import ffmpeg
from .reverse_progress import report
from .text_video import ApprovalRequired, check_active


def cut_audio(source, timing, evidence, path):
    # -copyts keeps stream offsets; trim relative to the decoded video origin.
    # first_pts adds leading silence when audio begins later than the video.
    start = timing['video_start_s'] + evidence['start_s']
    end = timing['video_start_s'] + evidence['end_s']
    duration = evidence['duration_s']
    ffmpeg(['-copyts', '-i', source, '-map', '0:a:0', '-vn', '-af',
            f'atrim=start={start:.9f}:end={end:.9f},asetpts=PTS-{start:.9f}/TB,aresample=16000:async=1:first_pts=0,apad,atrim=duration={duration:.9f}',
            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', path])
    with wave.open(str(path)) as audio:
        measured = audio.getnframes() / audio.getframerate()
        if audio.getnchannels() != 1 or abs(measured-duration) > 1/16000 + 1e-6:
            raise ValueError('Selected audio duration does not match measured video range')
    return measured


def prepare_audio(ctx, project, row, source, timing, evidence):
    if row.get('audio'):
        return row['audio']
    report(ctx, 'prepare_audio', 'กำลังเตรียมเสียงช่วงที่เลือก', detail='ตัดเสียงในเครื่อง ยังไม่มีค่า AI')
    audio = {'status': 'no_audio', 'source_sha256': project['source_sha256'],
             'source_start_s': evidence['start_s'], 'source_end_s': evidence['end_s'],
             'duration_s': evidence['duration_s'], 'timing': 'measured_selected_range'}
    if timing['has_audio']:
        check_active(ctx)
        path = Path(ctx.path('prompt-audio.wav'))
        cut_audio(source, timing, evidence, path)
        saved = save_private(ctx, project['id'], path, 'prompt_audio', content_type='audio/wav',
                             metadata={'selection_id': row['id'], 'source_start_s': evidence['start_s'], 'source_end_s': evidence['end_s']})
        audio.update(status='available', asset_id=str(saved['id']), sha256=saved['sha256'], sample_rate=16000, channels=1)
        # Add an audible preview without mutating previously approved frame evidence.
        preview = Path(ctx.path('prompt-preview.mp4'))
        if not preview.is_file():
            asset = ctx.db.one('SELECT * FROM reverse_assets WHERE id=%s AND project_id=%s', (evidence['preview_asset_id'], project['id']))
            fetch_private(ctx, asset, preview)
        muxed = Path(ctx.path('prompt-preview-audio.mp4'))
        ffmpeg(['-i', preview, '-i', path, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-t', str(evidence['duration_s']), '-movflags', '+faststart', muxed])
        saved = save_private(ctx, project['id'], muxed, 'prompt_clip_audio', content_type='video/mp4', metadata={'selection_id': row['id']})
        audio['preview_asset_id'] = str(saved['id'])
    ctx.db.q('UPDATE reverse_prompt_selections SET audio=%s WHERE id=%s AND audio IS NULL', (Jsonb(audio), row['id']))
    return audio


def transcription_rate():
    rate = json.loads(os.environ.get('MOTION_REVERSE_TRANSCRIBE_RATE_JSON', 'null'))
    model = os.environ.get('MOTION_REVERSE_TRANSCRIBE_MODEL', 'gpt-transcribe')
    if not rate or rate.get('model') != model or model != 'gpt-transcribe' or dt.datetime.now(dt.timezone.utc) >= dt.datetime.fromisoformat(rate['valid_until'].replace('Z', '+00:00')):
        raise ApprovalRequired('Transcription rate/model unavailable; configure Railway')
    return rate


def _transcription_call(ctx, project, task, quote):
    if fingerprint('OPENAI_API_KEY') != quote['key_fingerprints'].get('openai'):
        raise ApprovalRequired('OpenAI key changed after approval')
    key = 'reverse:' + quote['binding'] + ':' + task['slot']
    old = ctx.db.one('SELECT * FROM creative_calls WHERE job_id=%s AND call_key=%s', (ctx.job['id'], key))
    if not old:
        if dt.datetime.now(dt.timezone.utc) > dt.datetime.fromisoformat(quote['valid_until'].replace('Z', '+00:00')):
            raise ApprovalRequired('Approval expired')
        if transcription_rate() != task['rate'] or task['model'] != task['rate']['model']:
            raise ApprovalRequired('Transcription rate/model changed')
        status = requests.get('https://api.openai.com/v1/models/' + task['model'], headers={'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY']}, timeout=25, allow_redirects=False)
        if status.status_code != 200 or status.json().get('id') != task['model']:
            raise ApprovalRequired('Transcription model unavailable for this account')

    def submit(call_id):
        audio = task['payload']['audio']
        asset = ctx.db.one('SELECT * FROM reverse_assets WHERE id=%s AND project_id=%s', (audio['asset_id'], project['id']))
        if not asset or asset['sha256'] != audio['sha256']:
            raise ApprovalRequired('Selected audio asset changed')
        path = fetch_private(ctx, asset, ctx.path('asr-input.wav'))
        if file_sha(path) != audio['sha256']:
            raise ApprovalRequired('Audio checksum mismatch')
        check_active(ctx)
        report(ctx, 'transcribe', 'กำลังฟังเสียงและถอดบทพูด', detail='ส่งเฉพาะเสียงช่วงที่เลือก · เก็บภาษาต้นฉบับ')
        with open(path, 'rb') as stream:
            # Exactly one POST. This synchronous endpoint has no resumable ID.
            response = requests.post('https://api.openai.com/v1/audio/transcriptions',
                headers={'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY']},
                files={'file': ('selected-audio.wav', stream, 'audio/wav')},
                data={'model': task['model'], 'response_format': 'json'}, timeout=120, allow_redirects=False)
        if not response.ok:
            raise ApprovalRequired('Transcription HTTP ' + str(response.status_code) + '; no automatic POST retry')
        data = response.json()
        raw = Path(ctx.path('transcription-response.json')); raw.write_text(json.dumps(data, ensure_ascii=False))
        saved = save_private(ctx, project['id'], raw, 'provider_response', content_type='application/json', metadata={'call_id': str(call_id), 'quote_id': quote['id']})
        # Store even invalid answers, so validation cannot cause a second charge.
        return {'response': data, 'response_asset_id': str(saved['id']),
                'request_id': response.headers.get('x-request-id'),
                'usage': {'audio_seconds': audio['duration_s'], 'listed_estimate_usd': audio['duration_s']/60*task['rate']['per_minute'], 'cost_basis': 'duration estimate; not invoice'}}
    return Ledger(ctx).execute(key, 'openai', task['model'], 'planning', task['payload'], task['usd'], submit)


def dialogue_document(data, audio):
    text = data.get('text')
    if not isinstance(text, str) or len(text) > 20000 or any(ord(c) < 32 and c not in '\n\r\t' for c in text):
        raise ValueError('Invalid transcription text; saved raw response requires review')
    langs = data.get('languages', [])
    if not isinstance(langs, list):
        raise ValueError('Invalid transcription languages')
    codes = [x['code'] for x in langs if isinstance(x, dict) and isinstance(x.get('code'), str) and len(x['code']) <= 20]
    return {'status': 'transcribed' if text.strip() else 'no_speech_detected', 'text': text.strip(), 'languages': codes,
            'source_start_s': audio['source_start_s'], 'source_end_s': audio['source_end_s'], 'duration_s': audio['duration_s'],
            'timing': 'selected_range_only', 'speaker': 'unknown', 'review': 'asr_needs_owner_review'}


def transcribe(ctx, project, task, quote):
    from .reverse_prompts import canonical_hash, response_call, motion_lock, prompt_text
    selection = ctx.db.one('SELECT * FROM reverse_prompt_selections WHERE id=%s AND project_id=%s', (task['selection_id'], project['id']))
    if not selection or selection['audio'] != task['payload']['audio']:
        raise ApprovalRequired('Selected audio evidence changed')
    version_id = task['payload'].get('version_id')
    if not version_id:
        step = ctx.db.one("SELECT result FROM reverse_steps WHERE job_id=%s AND role='prompt_extract' AND status='complete'", (ctx.job['id'],))
        version_id = step and step['result'].get('version_id')
    old = ctx.db.one('SELECT * FROM reverse_prompt_versions WHERE id=%s AND project_id=%s AND selection_id=%s', (version_id, project['id'], selection['id']))
    if not old or motion_lock(old['document']) != old['locks_hash']:
        raise ApprovalRequired('Original Prompt A missing or changed')
    ident = canonical_hash({'audio_quote': quote['id'], 'parent': old['id']})
    if ctx.db.one('SELECT id FROM reverse_prompt_versions WHERE id=%s', (ident,)):
        return {'version_id': ident, 'cached': True}
    paid = response_call(ctx, project, task, quote, invoke=_transcription_call)
    doc = copy.deepcopy(old['document']); doc['audio'] = dialogue_document(paid['response'], selection['audio'])
    provenance = {**old['provenance'], 'operation': 'source_dialogue', 'transcription': {'model': task['model'], 'quote_id': quote['id'], 'response_asset_id': paid['response_asset_id'], 'audio_sha256': selection['audio']['sha256']}}
    report(ctx, 'save_dialogue', 'กำลังบันทึกบทพูดลง Prompt A และ B')
    ctx.db.q('INSERT INTO reverse_prompt_versions(id,project_id,selection_id,parent_id,document,replacements,prompt_a,prompt_b,locks_hash,provenance) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
             (ident, project['id'], selection['id'], old['id'], Jsonb(doc), Jsonb(old['replacements']), prompt_text(doc), prompt_text(doc, old['replacements']), motion_lock(doc), Jsonb(provenance)))
    return {'version_id': ident, 'selection_id': selection['id'], 'audio_status': doc['audio']['status']}
