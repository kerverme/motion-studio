"""Approved, resumable fal shots + ElevenLabs narration. Never retry an uncertain paid POST."""
import base64, datetime as dt, hashlib, json, math, os, subprocess, time
from pathlib import Path
from urllib.parse import urlparse
import numpy as np
import requests
from . import audio, config, pipeline, rendering, timeline as tl

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


def validate(ctx):
    spec = ctx.pkg.get('text_video') or {}
    inp, plan, approval = spec.get('input') or {}, spec.get('plan') or {}, spec.get('approval') or {}
    model = MODELS.get(inp.get('video_model'))
    if spec.get('version') != 1 or not model or inp.get('resolution') not in model[2]:
        raise ApprovalRequired('Unsupported Text to Video contract')
    shots = plan.get('shots') or []
    if inp.get('duration') not in (60, 90, 120) or len(shots) * 15 != inp['duration']:
        raise ApprovalRequired('Invalid approved duration/shot count')
    if [s['id'] for s in shots] != [f'shot_{i+1:02d}' for i in range(len(shots))]:
        raise ApprovalRequired('Invalid shot order')
    if approval.get('plan_hash') != digest({'input': inp, 'plan': plan}) or not approval.get('approved_at'):
        raise ApprovalRequired('ยังไม่มีการยืนยันราคาที่ตรงกับบทนี้')
    if ctx.pkg['voice']['voice_id'] != approval.get('voice_id') or approval.get('voice_model') != 'eleven_v3':
        raise ApprovalRequired('Voice changed after approval')
    return spec


def authorise(ctx, slot, provider):
    spec = validate(ctx)
    a = spec['approval']
    if dt.datetime.now(dt.timezone.utc) > dt.datetime.fromisoformat(a['valid_until']):
        raise ApprovalRequired('การอนุมัติหมดอายุ ต้องตรวจราคาใหม่ก่อนส่งคำขอที่เหลือ')
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


def paid_post(ctx, row, url, headers, payload, timeout):
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
                    detail = detail.replace(secret, '[redacted]').replace(secret.removeprefix('Key '), '[redacted]')
            detail = ' '.join(detail.split())[:400]
        except (ValueError, AttributeError, TypeError):
            pass
        update(ctx, row, 'failed' if known_rejection else 'unknown', {'http_status': r.status_code, 'error': detail}, r.headers.get('request-id'))
        raise ApprovalRequired(f"{row['slot']}: ผู้ให้บริการตอบ HTTP {r.status_code}{': '+detail if detail else ''} ยังไม่ส่งซ้ำ")
    try:
        return r, r.json()
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


def download_video(url, path):
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
                if size > 350 * 1024 * 1024:
                    raise ApprovalRequired('Generated shot exceeds 350 MB')
                f.write(chunk)
    os.replace(path+'.part', path)


def ffmpeg(args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-threads', '2']+args, check=True, capture_output=True)


def normalize_shot(raw, out, frame):
    info = audio.ffprobe(raw)
    duration = float(info['format']['duration'])
    if not 14.5 <= duration <= 17:
        raise ApprovalRequired(f'fal ส่งคลิปยาว {duration:.2f} วินาที แทนช็อต 15 วินาที ต้องตรวจช็อตนี้')
    ffmpeg(['-i', raw, '-an', '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=0.5', '-t', '15', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', out])
    # Extract from the NORMALISED visible end, not the provider's possible extra tail.
    ffmpeg(['-sseof', '-0.04', '-i', out, '-frames:v', '1', frame])


def fal_shot(ctx, shot, index, previous_frame):
    spec = ctx.pkg['text_video']; inp, plan = spec['input'], spec['plan']
    model = MODELS[inp['video_model']]; endpoint = model[1 if index else 0]
    prompt = plan['visual_bible']+'\n'+shot['visual_prompt']+'\nEnd this shot: '+shot['end_frame']+'\nNo text, subtitles, logos or spoken dialogue.'
    if index:
        prompt += '\nStart exactly from the supplied prior final frame. Preserve identity, outfit, props and screen direction; continue the action naturally.'
    if len(prompt) > 4096 and inp['video_model'] == 'grok_15':
        raise ApprovalRequired('Grok prompt exceeds 4096 characters; shorten the visual bible or shot prompt before approval')
    logical = {'endpoint': endpoint, 'prompt': prompt, 'resolution': inp['resolution'], 'duration': 15, 'previous_frame': previous_frame}
    slot = 'fal:'+shot['id']; old = latest(ctx, slot)
    if not old or old['status'] == 'failed':
        verify_price(ctx, endpoint)
    row, send = reserve(ctx, slot, 'fal', logical)
    if row['status'] == 'done':
        return row['data']
    if send:
        payload = {'prompt': prompt, 'duration': 15, 'resolution': inp['resolution'], 'enable_safety_checker': True}
        if inp['video_model'] == 'h3_max':
            payload['prompt_expansion_mode'] = 'disabled'
        if index:
            payload['image_url'] = ctx.store.signed_url(previous_frame, 86400)
        else:
            payload['aspect_ratio'] = '9:16'
        _, result = paid_post(ctx, row, 'https://queue.fal.run/'+endpoint, fal_headers(), payload, 60)
        request_id = result.get('request_id')
        if not request_id:
            update(ctx, row, 'unknown', {'error': 'Missing request ID'})
            raise ApprovalRequired('fal ไม่คืน request ID จึงไม่ส่งซ้ำ')
        data = {'endpoint': endpoint, 'status_url': queue_url(result.get('status_url')), 'response_url': queue_url(result.get('response_url')), 'input_frame_key': previous_frame}
        update(ctx, row, 'accepted', data, request_id)
        ctx.db.event(ctx.job['id'], f"fal รับช็อต {index+1}/{len(plan['shots'])} แล้ว", {'request_id': request_id, 'endpoint': endpoint}, status='RENDERING')
    deadline = time.monotonic()+2700
    while time.monotonic() < deadline:
        check_active(ctx)
        r = requests.get(queue_url(row['data']['status_url']), headers=fal_headers(), timeout=30)
        r.raise_for_status(); result = r.json()
        if result.get('status') == 'COMPLETED':
            r = requests.get(queue_url(row['data']['response_url']), headers=fal_headers(), timeout=60)
            if not r.ok or result.get('error'):
                update(ctx, row, 'failed', {**row['data'], 'http_status': r.status_code, 'error': 'Provider generation failed'})
                raise ApprovalRequired(f"fal ช็อต {index+1} ล้มเหลว ต้องยืนยันราคาซ่อมก่อนสร้างใหม่")
            result = r.json()
            if not result.get('video', {}).get('url'):
                update(ctx, row, 'failed', {**row['data'], 'error': 'Missing video'})
                raise ApprovalRequired(f"fal ช็อต {index+1} ไม่คืนวิดีโอ")
            raw, clip, frame = ctx.path('fal', shot['id']+'_raw.mp4'), ctx.path('fal', shot['id']+'.mp4'), ctx.path('fal', shot['id']+'_end.png')
            download_video(result['video']['url'], raw)
            try:
                normalize_shot(raw, clip, frame)
            except ApprovalRequired as e:
                update(ctx, row, 'failed', {**row['data'], 'error': str(e)})
                raise
            data = {**row['data'], 'request_id': str(row.get('request_id') or ''), 'raw_key': ctx.save('fal_source', raw), 'video_key': ctx.save('fal_shot', clip), 'frame_key': ctx.save('continuity_frame', frame), 'duration': 15}
            update(ctx, row, 'done', data)
            return data
        time.sleep(5)
    raise RuntimeError('fal ยังทำงานอยู่ เก็บ request ID แล้ว รอบถัดไปจะตรวจงานเดิม')


def narration(ctx, shot, index):
    shots = ctx.pkg['text_video']['plan']['shots']; slot = 'eleven:'+shot['id']
    payload = {'text': shot['narration'], 'model_id': 'eleven_v3', 'language_code': 'th', 'voice_settings': {'stability': .5, 'similarity_boost': .75}}
    logical = {**payload, 'voice_id': ctx.pkg['voice']['voice_id']}
    # Eleven v3 rejects request stitching. Keep this story context only in the
    # ledger identity, so existing accepted/done/uncertain calls remain protected.
    # https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching
    if index: logical['previous_text'] = shots[index-1]['narration']
    if index+1 < len(shots): logical['next_text'] = shots[index+1]['narration']
    old = latest(ctx, slot)
    if not old or old['status'] not in ('done', 'accepted'):
        item = authorise(ctx, slot, 'eleven');ctx.spend_check(item['credits'])
    row, send = reserve(ctx, slot, 'eleven', logical)
    if row['status'] == 'done': return row['data']
    if not send:
        raise ApprovalRequired(f'{slot}: เสียงเคยรับงานแล้วแต่ยังไม่มีไฟล์ ต้องตรวจผู้ให้บริการก่อน')
    url = config.ELEVENLABS_BASE+'/v1/text-to-speech/'+ctx.pkg['voice']['voice_id']+'/with-timestamps?output_format=mp3_44100_128'
    r, result = paid_post(ctx, row, url, {'xi-api-key': config.ELEVENLABS_API_KEY, 'Content-Type': 'application/json'}, payload, 300)
    mp3, alignment = ctx.path('voice', shot['id']+'.mp3'), ctx.path('voice', shot['id']+'.json')
    try:
        content = base64.b64decode(result['audio_base64'], validate=True)
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


def build_voice(ctx, voices):
    shots = ctx.pkg['text_video']['plan']['shots']; duration = ctx.pkg['text_video']['input']['duration']
    combined = np.zeros((int(duration*audio.SR), 2), dtype=np.float32); timeline = []
    for i, (s, v) in enumerate(zip(shots, voices)):
        src = ctx.fetch(v['audio_key'], ctx.path('voice', s['id']+'.mp3'))
        align = json.loads(Path(ctx.fetch(v['alignment_key'], ctx.path('voice', s['id']+'.json'))).read_text())
        dur = audio.duration(src); speed = max(1, dur/14.8)
        if speed > 1.2:
            raise ApprovalRequired(f"เสียงช็อต {i+1} ยาว {dur:.1f} วินาที ต้องย่อบทก่อนผลิต ไม่ตัดคำทิ้งและยังไม่ส่ง fal")
        if speed > 1.001:
            fitted = ctx.path('voice', s['id']+'_fit.wav');ffmpeg(['-i', src, '-af', f'atempo={speed:.7f}', fitted]);src = fitted
        samples = audio.decode(src); offset = int(i*15*audio.SR)
        combined[offset:offset+len(samples)] = samples
        text, starts, ends = tl.flatten_alignment(align)
        timeline += tl.build_timeline([{'id': s['id'], 'text': s['narration']}], text, [t/speed+i*15 for t in starts], [t/speed+i*15 for t in ends])
    raw = audio.write_wav(ctx.path('voice_full_raw.wav'), combined)
    finished = audio.finish(raw, ctx.path('voice_full.wav'))
    T = {'timeline': timeline, 'end': duration, 'cues': [], 'cue_misses': []}
    path = ctx.path('timeline.json');Path(path).write_text(json.dumps(T, ensure_ascii=False))
    ctx.db.save_stage(ctx.job, 'BUILDING_TIMELINE', {'timeline_key': ctx.save('timeline', path), 'end': duration})
    ctx.db.save_stage(ctx.job, 'GENERATING_AUDIO', {'narration_key': ctx.save('narration', finished), 'narration_duration': duration, 'sfx': {}, 'music_key': None})
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
    spec = validate(ctx);shots=spec['plan']['shots'];duration=spec['input']['duration']
    voices = []
    for i, shot in enumerate(shots):
        ctx.db.status(ctx.job, 'GENERATING_AUDIO', 'GENERATING_AUDIO', .05+i/len(shots)*.15, f'เสียงช็อต {i+1}/{len(shots)} (ใช้ไฟล์เดิมถ้าสำเร็จแล้ว)')
        voices.append(narration(ctx, shot, i))
    voice, T = build_voice(ctx, voices)
    previous = None;clips=[];manifest=[]
    for i, shot in enumerate(shots):
        ctx.db.status(ctx.job, 'RENDERING', 'RENDERING', .2+i/len(shots)*.5, f'fal ช็อต {i+1}/{len(shots)} ต่อจากเฟรมท้ายช็อตก่อน')
        result=fal_shot(ctx, shot, i, previous);previous=result['frame_key'];manifest.append(result)
        clips.append(ctx.fetch(result['video_key'], ctx.path('fal', shot['id']+'.mp4')))
    ctx.db.save_stage(ctx.job, 'FAL_SHOTS', {'shots': manifest})
    silent=rendering.concat(clips, ctx.path('video_silent.mp4'))
    ass=ctx.path('subtitles.ass');subtitle_ass(T, ass)
    from engine.core import FD
    final=ctx.path('final.mp4')
    ffmpeg(['-i', silent, '-i', voice, '-vf', f'ass={ass}:fontsdir={FD}', '-map','0:v:0','-map','1:a:0','-t',str(duration),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',final])
    ctx.db.status(ctx.job,'QUALITY_CHECK','QUALITY_CHECK',.8,'ตรวจไฟล์และภาพทุกช็อต')
    from . import qa
    info=audio.ffprobe(final);streams=info['streams'];v=next(x for x in streams if x['codec_type']=='video')
    frames=qa.frame_stats(final,[i*15+7 for i in range(len(shots))])
    wave=audio.decode(final)
    checks={'duration':abs(float(info['format']['duration'])-duration)<.25,'video':v['codec_name']=='h264' and v['width']==1080 and v['height']==1920,'audio':any(x['codec_type']=='audio' and x['codec_name']=='aac' for x in streams),'narration_present':audio.db(np.sqrt(np.mean(wave.astype(np.float64)**2)))>-45,'no_clipping':audio.db(np.abs(wave).max())<=-.5,'frames':all(x['decoded'] and x['std']>6 for x in frames),'no_black_frames':not qa.blackdetect(final)}
    checks={k:bool(v) for k,v in checks.items()}
    ffmpeg(['-i',final,'-f','null','-'])
    report={'ok':all(checks.values()),'checks':checks,'note':'Technical checks only; owner reviews generated continuity and meaning before publishing.'}
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
    db=DB()
    while not stop():
        try:
            data={'version':1,'fal':bool(os.environ.get('FAL_KEY')),'eleven':bool(config.ELEVENLABS_API_KEY),'voice_id':config.DEFAULT_VOICE_ID}
            db.q("INSERT INTO integrations(provider,data) VALUES('text_video_worker',%s::jsonb) ON CONFLICT(provider) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",(json.dumps(data),))
        except Exception as e:print('text-video capability pending:',type(e).__name__,flush=True)
        for _ in range(30):
            if stop():return
            time.sleep(1)
