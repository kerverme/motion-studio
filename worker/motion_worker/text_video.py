"""Approved, resumable fal shots + ElevenLabs narration. Never retry an uncertain paid POST."""
import base64, datetime as dt, hashlib, json, math, os, subprocess, time
from pathlib import Path
from urllib.parse import urlparse
import re
import rfc8785
import numpy as np
import requests
from . import audio, config, eleven, pipeline, rendering, timeline as tl

MODELS = {
    'h3_max': ('minimax/h3-max/text-to-video', 'minimax/h3-max/image-to-video', ('480P', '768P', '1080P')),
    'grok_15': ('xai/grok-imagine-video/v1.5/text-to-video', 'xai/grok-imagine-video/v1.5/image-to-video', ('480p', '720p', '1080p')),
}


class ApprovalRequired(RuntimeError):
    """Final failure: owner must reconcile or approve a new quote; no automatic spend."""


class JobCancelled(ApprovalRequired):
    pass


def check_active(ctx):
    state = ctx.db.one('SELECT status FROM jobs WHERE id=%s', (ctx.job['id'],))
    if state and state['status'] == 'CANCELLED':
        raise JobCancelled('งานถูกยกเลิกแล้ว ไม่ส่งคำขอเพิ่ม')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


PREVIOUS_FRAME = 'https://studio.cloudbath.co/internal/previous-frame.png'


def canonical_hash(value):
    # Matches the API's recursive, sorted-key ECMAScript JSON serialization.
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()


def scene_items(spec, shot):
    return [item for item in spec['approval']['fal'] if item['scene_id'] == shot['id']]


def validate(ctx):
    spec = ctx.pkg.get('text_video') or {}
    inp, plan, approval = spec.get('input') or {}, spec.get('plan') or {}, spec.get('approval') or {}
    shots = plan.get('shots') or []
    version = spec.get('version')
    if not shots or [s['id'] for s in shots] != [f'shot_{i+1:02d}' for i in range(len(shots))]:
        raise ApprovalRequired('Invalid shot order')
    fingerprint = canonical_hash if version == 2 else digest
    if approval.get('plan_hash') != fingerprint({'input': inp, 'plan': plan}) or not approval.get('approved_at'):
        raise ApprovalRequired('ยังไม่มีการยืนยันราคาที่ตรงกับบทนี้')
    if version == 1:
        model = MODELS.get(inp.get('video_model'))
        if not model or inp.get('resolution') not in model[2] or inp.get('duration') not in (60, 90, 120) or len(shots)*15 != inp['duration']:
            raise ApprovalRequired('Unsupported Text to Video contract')
        if ctx.pkg['voice']['voice_id'] != approval.get('voice_id') or approval.get('voice_model') != 'eleven_v3':
            raise ApprovalRequired('Voice changed after approval')
    elif version == 2:
        validate_production(spec, ctx.pkg.get('voice') or {})
    else:
        raise ApprovalRequired('Unsupported Text to Video contract')
    return spec


def validate_production(spec, voice):
    approval = spec['approval']
    if approval.get('payload_hash') != canonical_hash({'fal': approval['fal'], 'eleven': approval['eleven']}):
        raise ApprovalRequired('Approved production payload changed')
    if any(item['slot'].startswith('eleven:') for item in approval['eleven']):
        if voice.get('voice_id') != approval.get('voice_id') or voice.get('model_id') != approval.get('voice_model'):
            raise ApprovalRequired('Voice changed after approval')
    shots = spec['plan']['shots']
    expected_slots = []
    allowed_audio = set()
    total = 0
    for index, shot in enumerate(shots):
        items = scene_items(spec, shot)
        if not items:
            raise ApprovalRequired('Missing approved video for '+shot['id'])
        first = items[0]
        for variant, item in enumerate(items, 1):
            slot = 'fal:'+shot['id']+(f':{variant}' if variant > 1 else '')
            expected_slots.append(slot)
            if item['slot'] != slot or not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)*', item['endpoint_id']) or any(part in {'.','..'} for part in item['endpoint_id'].split('/')):
                raise ApprovalRequired('Invalid endpoint or generation slot')
            seconds, edited = item['generation_seconds'], item['edited_seconds']
            if not (0 < edited <= seconds <= 120 and edited == first['edited_seconds'] and math.isfinite(float(item['estimated_usd'])) and item['estimated_usd'] >= 0):
                raise ApprovalRequired('Invalid approved duration or cost')
            if not isinstance(item.get('payload'), dict) or not item.get('schema_hash'):
                raise ApprovalRequired('Missing verified endpoint schema or payload')
            if item.get('previous_frame') and not index:
                raise ApprovalRequired('First scene cannot reference a previous frame')
        total += first['edited_seconds']
        if not first['native_audio']:
            allowed_audio.update(('eleven:'+shot['id'], 'sfx:'+shot['id']))
    audio_slots = [item['slot'] for item in approval['eleven']]
    for item in approval['eleven']:
        if item['slot'].startswith('eleven:'):
            shot = next((s for s in shots if 'eleven:'+s['id'] == item['slot']), {})
            if item.get('text') != shot.get('narration') or item.get('model_id') != voice.get('model_id') or item.get('voice_id') != voice.get('voice_id'):
                raise ApprovalRequired('Approved narration does not match the voice request')
    if (len(expected_slots) != len(approval['fal']) or total > spec['input']['duration']+.001 or
            len(set(audio_slots)) != len(audio_slots) or not set(audio_slots).issubset(allowed_audio)):
        raise ApprovalRequired('Approved shots or audio do not match the scene plan')


def check_dispatch(ctx, slot):
    if not config.INTERNAL_TOKEN:
        raise ApprovalRequired('Private dispatch verification is not configured')
    if slot.startswith(('eleven:','sfx:')):
        from .video_capabilities import audio_offer
        item = next(x for x in ctx.pkg['text_video']['approval']['eleven'] if x['slot'] == slot)
        offer = audio_offer()
        if slot.startswith('eleven:'):
            matches = offer['voice_model'] == item['model_id'] and offer['voice_usd_per_1000_characters'] == item['usd_per_1000_characters']
        else:
            matches = (item['model_id'] in offer['sfx_models'] and offer['sfx_usd_per_second'] == item['usd_per_second']
                       and math.ceil(offer['sfx_credits_per_second']*item['duration_seconds']) == item['credits'])
        if not matches:
            raise ApprovalRequired(f'{slot}: ยืนยันโมเดลหรือราคา ElevenLabs ปัจจุบันไม่ได้ กรุณาคิดราคาใหม่')
    response = requests.post(config.API_INTERNAL_URL.rstrip('/')+'/internal/text-video/check-dispatch',
                             headers={'x-internal-token': config.INTERNAL_TOKEN},
                             json={'job_id':str(ctx.job['id']),'slot':slot,'approval_id':ctx.pkg['text_video']['approval']['id']},
                             timeout=110,allow_redirects=False)
    confirmed = response.json() if response.status_code == 200 else {}
    if confirmed.get('ok') is not True or confirmed.get('approval_id') != ctx.pkg['text_video']['approval']['id'] or confirmed.get('slot') != slot:
        raise ApprovalRequired(f'{slot}: ราคา โมเดล หรือคำอนุมัติยืนยันไม่ได้ กรุณาตรวจใบเสนอราคา')



def authorise(ctx, slot, provider):
    spec = validate(ctx)
    a = spec['approval']
    if dt.datetime.now(dt.timezone.utc) > dt.datetime.fromisoformat(a['valid_until']):
        raise ApprovalRequired('การอนุมัติหมดอายุ ต้องตรวจราคาใหม่ก่อนส่งคำขอที่เหลือ')
    if provider == 'openai':
        item = a.get('inspection') if slot.startswith('qa:') and any(x['slot'] == 'fal:'+slot[3:] for x in a['fal']) else None
    else:
        item = next((x for x in a[provider] if x['slot'] == slot), None)
    if not item:
        raise ApprovalRequired(f'{slot}: ไม่อยู่ในรายการค่าใช้จ่ายที่อนุมัติ')
    check_active(ctx)
    return item


def latest(ctx, slot):
    return ctx.db.one('SELECT * FROM text_video_calls WHERE job_id=%s AND slot=%s ORDER BY created_at DESC LIMIT 1', (ctx.job['id'], slot))


def reserve(ctx, slot, provider, payload):
    a = ctx.pkg['text_video']['approval']
    old = latest(ctx, slot)
    if old:
        if old['input_hash'] != digest(payload):
            raise ApprovalRequired(f'{slot}: ข้อมูลเปลี่ยน ต้องวางบทและยืนยันราคาใหม่')
        if old['status'] in ('done', 'accepted'):
            return old, False
        if old['status'] in ('submitting', 'unknown'):
            raise ApprovalRequired(f'{slot}: ยังยืนยันผลคำขอเดิมไม่ได้ จึงไม่ส่งซ้ำ โปรดตรวจประวัติผู้ให้บริการ')
        if old['approval_id'] == a['id'] or str(old['approval_id']) == a['id']:
            raise ApprovalRequired(f'{slot}: คำขอเดิมล้มเหลว ต้องยืนยันราคาซ่อมเฉพาะส่วนก่อนลองใหม่')
    authorise(ctx, slot, provider)
    if ctx.pkg['text_video']['version'] == 2:
        check_dispatch(ctx, slot)
    row = ctx.db.one("""INSERT INTO text_video_calls(job_id,slot,approval_id,provider,input_hash)
                     VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING *""",
                     (ctx.job['id'], slot, a['id'], provider, digest(payload)))
    if not row:
        raise ApprovalRequired(f'{slot}: มีผู้ส่งคำขอนี้แล้ว กรุณาตรวจสถานะเดิม')
    return row, True


def update(ctx, row, status, data, request_id=None, credits=0):
    # Credits and completion are one DB statement, so a restart cannot count them twice.
    ctx.db.q("""WITH changed AS (UPDATE text_video_calls SET status=%s,data=%s::jsonb,
                request_id=COALESCE(%s,request_id),updated_at=now()
                WHERE job_id=%s AND slot=%s AND approval_id=%s AND status<>'done' RETURNING 1)
                UPDATE jobs SET used_credits=used_credits+%s WHERE id=%s AND EXISTS(SELECT 1 FROM changed)""",
             (status, json.dumps(data), request_id, ctx.job['id'], row['slot'], row['approval_id'], credits, ctx.job['id']))
    row.update(status=status, data=data)
    if request_id:
        row['request_id'] = request_id
    ctx.job['used_credits'] = float(ctx.job.get('used_credits') or 0) + credits


def paid_post(ctx, row, url, headers, payload, timeout, binary=False):
    check_active(ctx)
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=timeout, allow_redirects=False)
    except requests.RequestException:
        update(ctx, row, 'unknown', {'error': 'Connection ended before the paid response was received'})
        raise ApprovalRequired(f"{row['slot']}: การเชื่อมต่อหลุด ยังไม่ทราบผล จึงไม่ส่งคำขอที่อาจคิดเงินซ้ำ")
    if not r.ok:
        known_rejection = 400 <= r.status_code < 500 and r.status_code != 408
        # Keep actionable provider errors, without storing credentials or raw bodies.
        detail = ''
        try:
            body = r.json()
            error = body.get('detail') or body.get('error') or {}
            if isinstance(error, dict):
                detail = ' · '.join(str(error[k]) for k in ('status', 'code', 'message') if isinstance(error.get(k), str))
            for name, secret in headers.items():
                if name.lower() in ('authorization', 'xi-api-key') and secret:
                    detail = detail.replace(secret, '[redacted]').replace(secret.split(' ',1)[-1], '[redacted]')
            detail = ' '.join(detail.split())[:400]
        except (ValueError, AttributeError, TypeError):
            pass
        update(ctx, row, 'failed' if known_rejection else 'unknown', {'http_status': r.status_code, 'error': detail}, r.headers.get('request-id'))
        raise ApprovalRequired(f"{row['slot']}: ผู้ให้บริการตอบ HTTP {r.status_code}{': '+detail if detail else ''} ยังไม่ส่งซ้ำ")
    try:
        return r, r.content if binary else r.json()
    except ValueError:
        update(ctx, row, 'unknown', {'error': 'Paid response is not JSON'})
        raise ApprovalRequired(f"{row['slot']}: คำตอบไม่ครบ ต้องตรวจคำขอเดิมก่อน")


def queue_url(url):
    u = urlparse(url or '')
    if u.scheme != 'https' or u.netloc != 'queue.fal.run' or '/requests/' not in u.path:
        raise ApprovalRequired('fal returned an invalid queue URL')
    return url


def fal_headers():
    key = os.environ.get('FAL_KEY')
    if not key:
        raise ApprovalRequired('FAL_KEY is not set on motion-worker')
    return {'Authorization': 'Key '+key, 'Content-Type': 'application/json', 'X-Fal-No-Retry': '1', 'x-app-fal-disable-fallback': 'true'}


def verify_price(ctx, endpoint):
    approved = next((x for x in ctx.pkg['text_video']['approval']['fal_rates'] if x['endpoint_id'] == endpoint), None)
    r = requests.get('https://api.fal.ai/v1/models/pricing', params={'endpoint_id': endpoint}, headers={'Authorization': fal_headers()['Authorization']}, timeout=30)
    r.raise_for_status()
    live = next((x for x in r.json().get('prices', []) if x['endpoint_id'] == endpoint), None)
    if not live or not approved or any(live.get(k) != approved.get(k) for k in ('unit', 'unit_price', 'currency')):
        raise ApprovalRequired('ราคา fal.ai เปลี่ยนจากที่ยืนยัน ต้องคิดราคาและยืนยันใหม่ก่อนส่งช็อตที่เหลือ')


def download_video(url, path, max_bytes=350 * 1024 * 1024):
    u = urlparse(url)
    host = u.hostname or ''
    if u.scheme != 'https' or not (host == 'fal.media' or host.endswith('.fal.media') or host == 'storage.googleapis.com') or u.username:
        raise ApprovalRequired('fal returned an unsupported media host')
    with requests.get(url, stream=True, timeout=120, allow_redirects=False) as r:
        r.raise_for_status()
        if 300 <= r.status_code < 400:
            raise ApprovalRequired('Unexpected media redirect')
        size = 0
        with open(path+'.part', 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                size += len(chunk)
                if size > max_bytes:
                    raise ApprovalRequired('Video exceeds the supported file size')
                f.write(chunk)
    os.replace(path+'.part', path)


def ffmpeg(args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-threads', '2']+args, check=True, capture_output=True)


def output_size(spec):
    if spec['version'] == 1:
        return 1080, 1920
    # Every segment needs identical dimensions for stream-copy concatenation.
    resolutions = {str(item['resolution']).lower() for item in spec['approval']['fal']}
    resolution = next(iter(resolutions)) if len(resolutions) == 1 else '720p'
    width = int(re.sub('[pP]$', '', resolution))
    if not 240 <= width <= 2160 or width % 2:
        raise ApprovalRequired('Invalid master resolution')
    return width, 2*round(width*16/18)


def normalize_shot(raw, out, frame, generation_seconds=15, edited_seconds=15, native_audio=False, size=(1080,1920)):
    width, height = size
    info = audio.ffprobe(raw)
    duration = float(info['format']['duration'])
    if native_audio and not any(x['codec_type'] == 'audio' for x in info['streams']):
        raise ApprovalRequired('ช็อตนี้ไม่มีแทร็กเสียงจากโมเดลตามที่อนุมัติ')
    if not generation_seconds-.5 <= duration <= generation_seconds+2:
        raise ApprovalRequired(f'fal ส่งคลิปยาว {duration:.2f} วินาที แทนช็อต {generation_seconds} วินาที ต้องตรวจช็อตนี้')
    ffmpeg(['-i', raw, '-an', '-vf', f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=0.5', '-t', str(edited_seconds), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', out])
    # Extract from the NORMALISED visible end, not the provider's possible extra tail.
    ffmpeg(['-sseof', '-0.04', '-i', out, '-frames:v', '1', frame])


def resolve_reference(value, signed_frame):
    if value == PREVIOUS_FRAME:
        if not signed_frame:
            raise ApprovalRequired('Approved previous frame is missing')
        return signed_frame
    if isinstance(value, dict):
        return {k: resolve_reference(v, signed_frame) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_reference(v, signed_frame) for v in value]
    return value


def prepare_source_clip(ctx, item):
    from .storage import sha256_file
    src = item.get('source_clip') or {}
    url = urlparse(src.get('url',''))
    host = url.hostname or ''
    seconds = src.get('seconds')
    if (not (host == 'fal.media' or host.endswith('.fal.media')) or url.scheme != 'https' or url.port not in (None,443)
            or url.username or url.password or src.get('field') != 'video_url' or item['payload'].get('video_url') != src.get('url')
            or not re.fullmatch('[0-9a-f]{64}',src.get('sha256','')) or type(seconds) is not int
            or not 1 <= seconds <= 60 or item['generation_seconds'] != seconds):
        raise ApprovalRequired('Unverified source video or duration')
    stem = 'source_'+src['sha256']
    raw = ctx.path('fal',stem+'.mp4')
    clip = ctx.path('fal',f'{stem}_{seconds}s.mp4')
    if not Path(raw).is_file() or sha256_file(raw) != src['sha256']:
        download_video(src['url'],raw,max_bytes=100*1024*1024)
    if sha256_file(raw) != src['sha256']:
        raise ApprovalRequired('เนื้อหาคลิปอ้างอิงเปลี่ยนตั้งแต่ยืนยันราคา')
    # Decode a local MP4 only. Strip metadata/tracks other than the verified input video;
    # both billing durations are now independent of the URL's future contents.
    result = subprocess.run(['ffprobe','-v','error','-protocol_whitelist','file','-f','mov','-select_streams','v:0',
                             '-show_entries','stream=duration','-of','default=nk=1:nw=1',raw],check=True,capture_output=True,timeout=30)
    measured = float(result.stdout)
    if not math.isfinite(measured) or measured < seconds-.001:
        raise ApprovalRequired('วิดีโอต้นทางสั้นกว่าระยะเวลาที่อนุมัติ')
    ffmpeg(['-protocol_whitelist','file','-f','mov','-i',raw,'-map','0:v:0','-map','0:a:0?','-map_metadata','-1',
            '-vf',"scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
            '-t',str(seconds),'-c:v','libx264','-threads','2','-preset','veryfast','-c:a','aac','-movflags','+faststart',clip])
    if abs(audio.duration(clip)-seconds) > .04:
        raise ApprovalRequired('ตรวจระยะเวลาคลิปต้นทางหลังตัดไม่ได้')
    key = ctx.save('verified_edit_source',clip,ctype='video/mp4')
    return ctx.store.signed_url(key,86400)


def legacy_request(ctx, shot, index, previous_frame):
    spec = ctx.pkg['text_video']; inp, plan = spec['input'], spec['plan']
    model = MODELS[inp['video_model']]; endpoint = model[1 if index else 0]
    prompt = plan['visual_bible']+'\n'+shot['visual_prompt']+'\nEnd this shot: '+shot['end_frame']+'\nNo text, subtitles, logos or spoken dialogue.'
    if index:
        prompt += '\nStart exactly from the supplied prior final frame. Preserve identity, outfit, props and screen direction; continue the action naturally.'
    if len(prompt) > 4096 and inp['video_model'] == 'grok_15':
        raise ApprovalRequired('Grok prompt exceeds 4096 characters; shorten the visual bible or shot prompt before approval')
    logical = {'endpoint': endpoint, 'prompt': prompt, 'resolution': inp['resolution'], 'duration': 15, 'previous_frame': previous_frame}
    payload = {'prompt': prompt, 'duration': 15, 'resolution': inp['resolution'], 'enable_safety_checker': True}
    if inp['video_model'] == 'h3_max':
        payload['prompt_expansion_mode'] = 'disabled'
    if index:
        payload['image_url'] = PREVIOUS_FRAME
    else:
        payload['aspect_ratio'] = '9:16'
    return endpoint, logical, payload


def reported_cost_usd(result):
    for key, field in (('billing','total_cost'),('usage','cost')):
        usage = result.get(key)
        if not isinstance(usage,dict) or usage.get('currency','USD') != 'USD':
            continue
        cost = usage.get(field)
        if type(cost) in (int,float) and math.isfinite(cost) and cost >= 0:
            return cost
    return None


def fal_shot(ctx, shot, index, previous_frame, approved=None):
    if approved:
        endpoint, slot, payload = approved['endpoint_id'], approved['slot'], approved['payload']
        previous_frame = previous_frame if approved.get('previous_frame') else None
        if (PREVIOUS_FRAME in json.dumps(payload)) != bool(previous_frame):
            raise ApprovalRequired('Referenced previous frame does not match the approval')
        logical = {'endpoint': endpoint, 'payload': payload, 'previous_frame': previous_frame}
    else:
        endpoint, logical, payload = legacy_request(ctx, shot, index, previous_frame)
        slot = 'fal:'+shot['id']
        old = latest(ctx, slot)
        if not old or old['status'] == 'failed':
            verify_price(ctx, endpoint)
    signed_source = None
    if approved and (approved.get('source_clip') or (approved.get('category') in ('video-editing','video-to-video') and 'video_url' in payload)):
        old = latest(ctx,slot)
        logical['source_clip'] = approved.get('source_clip')
        if not old or old['status'] == 'failed':
            signed_source = prepare_source_clip(ctx,approved)
    row, send = reserve(ctx, slot, 'fal', logical)
    if row['status'] == 'done':
        return row['data']
    if send:
        wire = resolve_reference(payload, ctx.store.signed_url(previous_frame, 86400) if previous_frame else None)
        if signed_source:
            wire['video_url'] = signed_source
        _, result = paid_post(ctx, row, 'https://queue.fal.run/'+endpoint, fal_headers(), wire, 60)
        request_id = result.get('request_id')
        if not request_id:
            update(ctx, row, 'unknown', {'error': 'Missing request ID'})
            raise ApprovalRequired('fal ไม่คืน request ID จึงไม่ส่งซ้ำ')
        data = {'endpoint': endpoint, 'status_url': queue_url(result.get('status_url')), 'response_url': queue_url(result.get('response_url')), 'input_frame_key': previous_frame, 'submitted_at': time.time()}
        update(ctx, row, 'accepted', data, request_id)
        ctx.db.event(ctx.job['id'], f"fal รับช็อต {index+1}/{len(ctx.pkg['text_video']['plan']['shots'])} แล้ว", {'request_id': request_id, 'endpoint': endpoint}, status='RENDERING')
    last_state = None
    deadline = time.monotonic()+2700
    while time.monotonic() < deadline:
        check_active(ctx)
        r = requests.get(queue_url(row['data']['status_url']), headers=fal_headers(), timeout=30)
        r.raise_for_status(); result = r.json()
        state = result.get('status')
        if approved and state != last_state and state in ('IN_QUEUE','IN_PROGRESS','COMPLETED'):
            ctx.db.event(ctx.job['id'], f'fal {slot} · {state}', {'slot':slot,'provider_status':state,'queue_position':result.get('queue_position')}, status='RENDERING')
            last_state = state
        if state in ('FAILED','CANCELLED','CANCELED'):
            update(ctx, row, 'failed', {**row['data'], 'error':'Provider generation '+state})
            raise ApprovalRequired(f'{slot}: fal {state}')
        if state == 'COMPLETED':
            r = requests.get(queue_url(row['data']['response_url']), headers=fal_headers(), timeout=60)
            if not r.ok or result.get('error'):
                update(ctx, row, 'failed', {**row['data'], 'http_status': r.status_code, 'error': 'Provider generation failed'})
                raise ApprovalRequired(f"fal ช็อต {index+1} ล้มเหลว ต้องยืนยันราคาซ่อมก่อนสร้างใหม่")
            generation_ms = round(1000*(time.time()-row['data']['submitted_at'])) if row['data'].get('submitted_at') else None
            result = r.json()
            # Only use an explicitly provider-reported USD charge. Missing billing information remains NULL.
            actual_usd = reported_cost_usd(result)
            if not result.get('video', {}).get('url'):
                update(ctx, row, 'failed', {**row['data'], 'error': 'Missing video'})
                raise ApprovalRequired(f"fal ช็อต {index+1} ไม่คืนวิดีโอ")
            stem = slot.removeprefix('fal:').replace(':','_variant_')
            raw, clip, frame = [ctx.path('fal', stem+suffix) for suffix in ('_raw.mp4','.mp4','_end.png')]
            seconds = approved['generation_seconds'] if approved else 15
            edited = approved['edited_seconds'] if approved else 15
            download_video(result['video']['url'], raw)
            try:
                normalize_shot(raw, clip, frame, seconds, edited, approved and approved['native_audio'], output_size(ctx.pkg['text_video']))
            except ApprovalRequired as e:
                update(ctx, row, 'failed', {**row['data'], 'error': str(e)})
                raise
            data = {**row['data'], 'request_id': str(row.get('request_id') or ''), 'raw_key': ctx.save('fal_source', raw), 'video_key': ctx.save('fal_shot', clip), 'frame_key': ctx.save('continuity_frame', frame), 'duration': edited, 'generated_duration': audio.duration(raw), 'generation_ms': generation_ms, 'actual_usd': actual_usd}
            update(ctx, row, 'done', data)
            return data
        time.sleep(5)
    raise RuntimeError('fal ยังทำงานอยู่ เก็บ request ID แล้ว รอบถัดไปจะตรวจงานเดิม')


def narration(ctx, shot, index):
    shots = ctx.pkg['text_video']['plan']['shots']; slot = 'eleven:'+shot['id']
    payload = {'text': shot['narration'], 'model_id': 'eleven_v3', 'language_code': 'th', 'voice_settings': {'stability': .5, 'similarity_boost': .75}}
    spec = ctx.pkg['text_video']
    model = spec['approval']['voice_model']
    voice_id = ctx.pkg['voice']['voice_id']
    url = config.ELEVENLABS_BASE+'/v1/text-to-speech/'+voice_id+'/with-timestamps?output_format=mp3_44100_128'
    if spec['version'] == 2:
        if model not in ('eleven_v3','eleven_v4'):
            raise ApprovalRequired('Unsupported approved ElevenLabs model')
        payload['model_id'] = model
        if model == 'eleven_v4':
            payload = {'inputs':[{'text':shot['narration'],'voice_id':voice_id}],'model_id':model,'language_code':'th',
                       'settings':{'stability':.5,'similarity':.75}}
            url = config.ELEVENLABS_BASE+'/v1/text-to-dialogue/with-timestamps?output_format=mp3_44100_128'
    logical = {**payload, 'voice_id': voice_id}
    # Eleven v3 rejects request stitching. Keep this story context only in the
    # ledger identity, so existing accepted/done/uncertain calls remain protected.
    # https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching
    if spec['version'] == 1 and index: logical['previous_text'] = shots[index-1]['narration']
    if spec['version'] == 1 and index+1 < len(shots): logical['next_text'] = shots[index+1]['narration']
    old = latest(ctx, slot)
    if not old or old['status'] not in ('done', 'accepted'):
        item = authorise(ctx, slot, 'eleven');ctx.spend_check(item['credits'])
    row, send = reserve(ctx, slot, 'eleven', logical)
    if row['status'] == 'done': return row['data']
    if not send:
        raise ApprovalRequired(f'{slot}: เสียงเคยรับงานแล้วแต่ยังไม่มีไฟล์ ต้องตรวจผู้ให้บริการก่อน')
    r, result = paid_post(ctx, row, url, {'xi-api-key': config.ELEVENLABS_API_KEY, 'Content-Type': 'application/json'}, payload, 300)
    mp3, alignment = ctx.path('voice', shot['id']+'.mp3'), ctx.path('voice', shot['id']+'.json')
    try:
        content = base64.b64decode(result['audio_base64'], validate=True)
        if spec['version'] == 2:
            al, _ = eleven.validated_alignment(result, shot['narration'])
            if model == 'eleven_v4':
                eleven.validate_dialogue_segments(result,voice_id,al)
        else:
            al = result.get('alignment') or result['normalized_alignment']
        if not content or not al['characters']: raise ValueError('Missing content')
        Path(mp3).write_bytes(content);Path(alignment).write_text(json.dumps(al))
        data = {'audio_key': ctx.save('shot_narration', mp3), 'alignment_key': ctx.save('shot_alignment', alignment)}
        cost = float(r.headers.get('character-cost') or r.headers.get('x-character-count') or len(shot['narration']))
        if not math.isfinite(cost) or cost < 0: raise ValueError('Invalid character cost')
        data['credits'] = cost
    except Exception:
        update(ctx, row, 'unknown', {'error': 'Audio response received but could not be persisted'})
        raise ApprovalRequired(f'{slot}: ได้คำตอบแล้วแต่เก็บเสียงไม่ครบ จึงไม่สร้างเสียงซ้ำ')
    update(ctx, row, 'done', data, r.headers.get('request-id'), credits=cost)
    if cost > next(x['credits'] for x in ctx.pkg['text_video']['approval']['eleven'] if x['slot'] == slot):
        raise ApprovalRequired('ElevenLabs คิดเครดิตเกินประมาณการที่อนุมัติ เก็บเสียงแล้วและหยุดก่อนส่งคำขอเพิ่ม')
    return data


def sound_effect(ctx, shot, item):
    slot = item['slot']
    if item['model_id'] not in ('eleven_text_to_sound_v3','eleven_text_to_sound_v2'):
        raise ApprovalRequired('Unsupported SFX model')
    payload = {'model_id':item['model_id'],'text':item['text'],'duration_seconds':item['duration_seconds'],'prompt_influence':.5}
    old = latest(ctx,slot)
    if not old or old['status'] == 'failed':
        ctx.spend_check(item['credits'])
    row, send = reserve(ctx,slot,'eleven',payload)
    if row['status'] == 'done':
        return row['data']
    if not send:
        raise ApprovalRequired('ต้องตรวจคำขอเสียงประกอบเดิมก่อน')
    response, wav = paid_post(ctx,row,config.ELEVENLABS_BASE+'/v1/sound-generation?output_format=mp3_44100_128',
                              {'xi-api-key':config.ELEVENLABS_API_KEY},payload,160,binary=True)
    try:
        path = ctx.path('voice',shot['id']+'_sfx.mp3')
        Path(path).write_bytes(wav)
        if audio.duration(path) <= 0:
            raise ValueError('Missing sound effect')
        cost = float(response.headers.get('character-cost') or response.headers.get('x-character-count') or item['credits'])
        if not math.isfinite(cost) or cost < 0:
            raise ValueError('Invalid SFX cost')
        data = {'audio_key':ctx.save('shot_sfx',path),'credits':cost}
    except Exception:
        update(ctx,row,'unknown',{'error':'SFX response could not be persisted'})
        raise ApprovalRequired('ได้รับเสียงประกอบแล้วแต่ยังเก็บไฟล์ไม่ได้ ต้องตรวจคำขอเดิมก่อน')
    update(ctx,row,'done',data,response.headers.get('request-id'),credits=cost)
    if cost > item['credits']:
        raise ApprovalRequired('ElevenLabs คิดเครดิตเสียงประกอบเกินที่อนุมัติ')
    return data


def scene_lengths(spec):
    return [scene_items(spec, s)[0]['edited_seconds'] if spec['version'] == 2 else 15 for s in spec['plan']['shots']]


def editorial_caption(shot, start, duration):
    # Native audio has no verified word alignment. Page the approved on-screen narration within its edit.
    from pythainlp.tokenize import word_tokenize
    pages, current = [], ''
    for word in word_tokenize(shot['narration'],engine='newmm'):
        if current.strip() and len(current)+len(word) > 48:
            pages.append(current.strip())
            current = ''
        current += word
    if current.strip():
        pages.append(current.strip())
    total = sum(map(len,pages))
    phrases, count = [], 0
    for page in pages:
        begin = start+duration*count/total
        count += len(page)
        phrases.append({'s':begin,'e':start+duration*count/total,'text':page,'words':[]})
    return {'id':shot['id'],'s':start,'e':start+duration,'phrases':phrases,'timing':'editorial_scene','caption_source':'approved_script'}


def build_voice(ctx, voices, native=None, effects=None):
    spec = ctx.pkg['text_video']
    shots, lengths = spec['plan']['shots'], scene_lengths(spec)
    duration = sum(lengths)
    combined = np.zeros((round(duration*audio.SR), 2), dtype=np.float32)
    timeline = []
    offset = 0
    for i, (s, v, length) in enumerate(zip(shots, voices, lengths)):
        start, end = round(offset*audio.SR), round((offset+length)*audio.SR)
        if v:
            src = ctx.fetch(v['audio_key'], ctx.path('voice', s['id']+'.mp3'))
            align = json.loads(Path(ctx.fetch(v['alignment_key'], ctx.path('voice', s['id']+'.json'))).read_text())
            dur = audio.duration(src)
            speed = max(1, dur/max(.1,length-.2))
            if speed > 1.2:
                raise ApprovalRequired(f'เสียงช็อต {i+1} ยาว {dur:.1f} วินาที ต้องย่อบทก่อนผลิต')
            if speed > 1.001:
                fitted = ctx.path('voice', s['id']+'_fit.wav')
                ffmpeg(['-i',src,'-af',f'atempo={speed:.7f}',fitted])
                src = fitted
            samples = audio.decode(src)[:end-start]
            combined[start:start+len(samples)] = samples
            text, starts, ends = tl.flatten_alignment(align)
            timeline += tl.build_timeline([{'id':s['id'],'text':s['narration']}],text,
                                          [t/speed+offset for t in starts],[t/speed+offset for t in ends])
        if native and s['id'] in native:
            timeline.append(editorial_caption(s,offset,length))
            samples = audio.decode(native[s['id']])[:end-start]
            combined[start:start+len(samples)] += samples
        if effects and s['id'] in effects:
            fx = ctx.fetch(effects[s['id']]['audio_key'],ctx.path('voice',s['id']+'_sfx.mp3'))
            samples = audio.decode(fx)[:end-start]
            combined[start:start+len(samples)] += samples*.32
        offset += length
    peak = np.max(np.abs(combined))
    if peak > .9:
        combined *= .9/peak
    raw = audio.write_wav(ctx.path('voice_full_raw.wav'), combined)
    music = ctx.pkg.get('music') or {}
    music_key = None
    if music.get('source') == 'default':
        music_key = pipeline.default_music_key(ctx)
        if music_key:
            music_path = ctx.fetch(music_key,ctx.path('default_music.mp3'))
            mix, _ = audio.mix(raw,duration,{},[],music_path,music_volume=.15,fade_out=min(2,duration))
            raw = audio.write_wav(ctx.path('master_mix.wav'),mix)
    finished = audio.finish(raw,ctx.path('voice_full.wav'))
    T = {'timeline':timeline,'end':duration,'cues':[],'cue_misses':[]}
    path = ctx.path('timeline.json');Path(path).write_text(json.dumps(T,ensure_ascii=False))
    ctx.db.save_stage(ctx.job,'BUILDING_TIMELINE',{'timeline_key':ctx.save('timeline',path),'end':duration})
    ctx.db.save_stage(ctx.job,'GENERATING_AUDIO',{'narration_key':ctx.save('narration',finished),'narration_duration':duration,
                     'sfx':{key:v['audio_key'] for key,v in (effects or {}).items()},'music_key':music_key})
    return finished, T


def subtitle_ass(T, path):
    def stamp(t):
        cs = max(0, round(t*100));return f'{cs//360000}:{cs//6000%60:02d}:{cs//100%60:02d}.{cs%100:02d}'
    header = '''[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Kanit,68,&H0000E8FF,&H00FFFFFF,&H00190F26,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,70,70,300,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    lines = [header]
    # Bound line length with real Thai word tokens; no fabricated timing.
    for seg in T['timeline']:
        for phrase in seg['phrases']:
            if seg.get('timing') == 'editorial_scene':
                text = re.sub(r'[\\{}\r\n]',' ',phrase['text'])
                lines.append(f"Dialogue: 0,{stamp(phrase['s'])},{stamp(phrase['e'])},Default,,0,0,0,,{text}\n")
                continue
            groups, cur = [], []
            for word in phrase['words']:
                if sum(len(w['w']) for w in cur)+len(word['w']) > 25 and cur: groups.append(cur);cur=[]
                cur.append(word)
            if cur: groups.append(cur)
            for words in groups:
                txt = ''.join('{\\k'+str(max(1,round((w['e']-w['s'])*100)))+'}'+w['w'].replace('\\','').replace('{','').replace('}','').replace('\n',' ') for w in words)
                lines.append(f"Dialogue: 0,{stamp(words[0]['s'])},{stamp(words[-1]['e']+.12)},Default,,0,0,0,,{txt}\n")
    Path(path).write_text(''.join(lines))


def run(ctx):
    check_active(ctx)
    from . import video_inspection
    spec = validate(ctx)
    shots = spec['plan']['shots']
    v2 = spec['version'] == 2
    lengths = scene_lengths(spec)
    duration = sum(lengths)
    voices, effects = [], {}
    approved_audio = {a['slot']:a for a in spec['approval']['eleven']}
    for i, shot in enumerate(shots):
        ctx.db.status(ctx.job,'GENERATING_AUDIO','GENERATING_AUDIO',.05+i/len(shots)*.15,f'ตรวจเสียงช็อต {i+1}/{len(shots)}')
        slot = 'eleven:'+shot['id']
        voice = narration(ctx,shot,i) if not v2 or slot in approved_audio else None
        voices.append(voice)
        if voice:
            src = ctx.fetch(voice['audio_key'],ctx.path('voice',shot['id']+'.mp3'))
            if audio.duration(src) > max(.1,lengths[i]-.2)*1.2:
                raise ApprovalRequired(f'เสียงช็อต {i+1} ยาวเกินช่วงตัดต่อ ต้องย่อบทก่อนส่ง fal')
        effect = approved_audio.get('sfx:'+shot['id'])
        if v2 and effect:
            effects[shot['id']] = sound_effect(ctx,shot,effect)
    previous, clips, manifest, native_paths, reviews = None, [], [], {}, []
    for i, shot in enumerate(shots):
        ctx.db.status(ctx.job,'RENDERING','RENDERING',.2+i/len(shots)*.5,f'กำลังผลิตช็อต {i+1}/{len(shots)}')
        variants = scene_items(spec,shot) if v2 else [None]
        first = None
        for item in variants:
            # A derivative plan can reuse previously paid media. Attribute the observations to the original generation.
            old = latest(ctx,item['slot']) if v2 else None
            record = None
            if item and not (old and (old.get('data') or {}).get('reused_from_job')):
                record = video_inspection.benchmark(ctx,shot,item,old['approval_id'] if old and old['status'] in ('accepted','done') else None)
            try:
                result = fal_shot(ctx,shot,i,previous,item)
            except ApprovalRequired as exc:
                if record and not isinstance(exc,JobCancelled):
                    video_inspection.outcome(ctx,record['id'],error=exc)
                raise
            if record:
                video_inspection.outcome(ctx,record['id'],result=result)
                ctx.db.status(ctx.job,'QUALITY_CHECK','VIDEO_INSPECTION',.2+i/len(shots)*.5,
                              'กำลังตรวจภาพจริง '+item['slot'])
                actual = result.get('actual_usd')
                if actual is not None and actual > item['estimated_usd'] + 1e-6 and str(record['approval_id']) == str(spec['approval']['id']):
                    raise ApprovalRequired('ยอดที่ fal แจ้งสูงกว่าที่อนุมัติ เก็บช็อตแล้ว กรุณาตรวจราคาก่อนส่งงานที่เหลือ')
                reviews.append(video_inspection.inspect_generated(ctx,record,item,result,shot))
            manifest.append({**result, 'slot':item['slot']} if item else result)
            if first is None:
                first = result
                if item and item['native_audio']:
                    native_paths[shot['id']] = ctx.fetch(result['raw_key'],ctx.path('fal',shot['id']+'_raw.mp4'))
        previous = first['frame_key']
        clips.append(ctx.fetch(first['video_key'],ctx.path('fal',shot['id']+'.mp4')))
    ctx.db.save_stage(ctx.job,'FAL_SHOTS',{'shots':manifest})
    ctx.db.status(ctx.job,'RENDERING','EDITING',.75,'ประกอบภาพ เสียง และคำบรรยาย')
    voice, T = build_voice(ctx,voices,native_paths,effects)
    silent=rendering.concat(clips, ctx.path('video_silent.mp4'))
    ass=ctx.path('subtitles.ass');subtitle_ass(T, ass)
    from engine.core import FD
    final=ctx.path('final.mp4')
    ffmpeg(['-i', silent, '-i', voice, '-vf', f'ass={ass}:fontsdir={FD}', '-map','0:v:0','-map','1:a:0','-t',str(duration),'-c:v','libx264','-threads','2','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',final])
    ctx.db.status(ctx.job,'QUALITY_CHECK','QUALITY_CHECK',.8,'ตรวจไฟล์และภาพทุกช็อต')
    from . import qa
    info=audio.ffprobe(final);streams=info['streams'];v=next(x for x in streams if x['codec_type']=='video')
    frames=qa.frame_stats(final,[sum(lengths[:i])+length/2 for i,length in enumerate(lengths)])
    width,height=output_size(spec)
    wave=audio.decode(final)
    checks={'duration':abs(float(info['format']['duration'])-duration)<.25,'video':v['codec_name']=='h264' and v['width']==width and v['height']==height,'audio':any(x['codec_type']=='audio' and x['codec_name']=='aac' for x in streams),'narration_present':audio.db(np.sqrt(np.mean(wave.astype(np.float64)**2)))>-45,'no_clipping':audio.db(np.abs(wave).max())<=-.5,'frames':all(x['decoded'] and x['std']>6 for x in frames),'no_black_frames':not qa.blackdetect(final)}
    if v2:
        checks['audio_signal_present'] = checks.pop('narration_present')
    checks={k:bool(v) for k,v in checks.items()}
    ffmpeg(['-i',final,'-f','null','-'])
    report={'ok':all(checks.values()),'checks':checks,'note':'Technical checks only; owner reviews generated continuity and meaning before publishing.'}
    if v2:
        report.update(narration_content='not_assessed', audio_sync='not_assessed')
        report.update(scene_inspections=reviews, requires_owner_review=any(r.get('status') != 'passed' for r in reviews))
    ctx.db.q('UPDATE jobs SET qa_report=%s::jsonb WHERE id=%s',(json.dumps(report),ctx.job['id']))
    if not report['ok']:raise ApprovalRequired('วิดีโอไม่ผ่าน QA: '+json.dumps(checks))
    key=ctx.save('video',final,f'{ctx.prefix}/render/final.mp4','video/mp4')
    ctx.db.save_stage(ctx.job,'QUALITY_CHECK',{'final_key':key,'ok':True})
    ctx.db.status(ctx.job,'UPLOADING_DRIVE','UPLOADING_DRIVE',.9,'ส่งมอบคลิปโดยไม่โพสต์อัตโนมัติ')
    # Existing uploader, thumbnails, Ready list and Notion integration are shared.
    result=ctx.r.get('UPLOADING_DRIVE') or pipeline.stage_upload(ctx)
    ctx.db.save_stage(ctx.job,'UPLOADING_DRIVE',result)
    ctx.db.q('UPDATE jobs SET result=%s::jsonb,locked_by=NULL,locked_until=NULL,error=NULL WHERE id=%s',(json.dumps(result),ctx.job['id']))
    ctx.db.status(ctx.job,'READY_TO_POST','READY_TO_POST',1.0,'Text to Video พร้อมตรวจและโพสต์',{'episode_number':result['episode_number']})
    ctx.db.q("UPDATE text_video_plans SET status='done',error=NULL,updated_at=now() WHERE job_id=%s",(ctx.job['id'],))
    return result


def capability_loop(stop):
    from .db import DB
    from .video_capabilities import probe
    db=None
    metadata = {}
    next_probe = 0
    while not stop():
        try:
            if db is None:
                db = DB()
            if time.monotonic() >= next_probe:
                metadata = probe()
                next_probe = time.monotonic()+(3600 if metadata['voice_models'] else 300)
            data={**metadata,'version':1,'fal':bool(os.environ.get('FAL_KEY')),'eleven':bool(config.ELEVENLABS_API_KEY),'voice_id':config.DEFAULT_VOICE_ID}
            db.q("INSERT INTO integrations(provider,data) VALUES('text_video_worker',%s::jsonb) ON CONFLICT(provider) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",(json.dumps(data),))
        except Exception as e:print('text-video capability pending:',type(e).__name__,flush=True)
        for _ in range(30):
            if stop():return
            time.sleep(1)
