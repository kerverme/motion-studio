"""UGC queue consumer. Reuses Studio's receipt ledger, fal client and Thai narration."""
import json
import math
import re
import subprocess
from pathlib import Path

from . import audio, r2, rendering, text_video as video


def validate_production(ctx, spec):
    approval = spec['approval']
    ugc = ctx.pkg['ugc']
    shots = spec['plan']['shots']
    seconds = spec['input']['duration']
    media = ugc['media']
    fal, voice = approval['fal'], approval['eleven']
    if not (spec['input'].get('ugc') is True and type(seconds) is int and 8 <= seconds <= 30
            and 2 <= len(shots) <= 10 and 3 <= shots[0]['seconds'] <= 5
            and all(type(s['seconds']) is int and 2 <= s['seconds'] <= 15 for s in shots)
            and sum(s['seconds'] for s in shots) == seconds
            and shots[0]['mode'] == shots[-1]['mode'] == 'original'
            and approval['payload_hash'] == video.canonical_hash({'fal': fal, 'eleven': voice})
            and media == approval['media']):
        raise video.ApprovalRequired('UGC ไม่ตรงกับฉบับที่อนุมัติหรือยาวเกิน 30 วินาที')
    # Scene order can be edited; slot IDs remain attached to their existing receipts.
    if len({s['id'] for s in shots}) != len(shots) or not all(re.fullmatch(r'shot_\d{2}',s['id']) for s in shots):
        raise video.ApprovalRequired('เลขฉาก UGC ไม่ถูกต้อง')
    sources = {x['id']: x for x in media}
    paid = {x['slot']:x for x in fal}
    voice_slots = {x['slot']:x for x in voice}
    paid_scenes = [s for s in shots if s['mode'] == 'fal']
    if (len(paid) != len(fal) or len(paid) != len(paid_scenes) or len(voice_slots) != len(voice)
            or len(voice_slots) != len(shots)):
        raise video.ApprovalRequired('จำนวนรายการค่าใช้จ่าย UGC ไม่ตรงกับฉาก')
    for s in shots:
        if s['media_id'] not in sources or s['mode'] not in ('fal','original'):
            raise video.ApprovalRequired('ไม่พบสื่อตามที่อนุมัติในฉาก '+s['id'])
        v = voice_slots.get('eleven:'+s['id'])
        if not (v and v['text']==s['narration'] and v['voice_id']==ctx.pkg['voice']['voice_id']==approval['voice_id']
                and v['model_id']==ctx.pkg['voice']['model_id']==approval['voice_model']):
            raise video.ApprovalRequired('บทหรือเสียง UGC เปลี่ยนหลังอนุมัติ')
        if s['mode']=='original':
            continue
        item = paid.get('fal:'+s['id'])
        endpoint = item.get('endpoint_id','') if item else ''
        if not (item and '/image-to-video' in endpoint and re.fullmatch(r'[\w.-]+(?:/[\w.-]+)+',endpoint,re.ASCII)
                and not set(endpoint.split('/')) & {'.','..'}
                and item['media_id']==s['media_id'] and item['edited_seconds']==s['seconds']
                and s['seconds']<=item['generation_seconds']<=30
                and item['estimated_usd']>0 and item['native_audio'] is False
                and video.PREVIOUS_FRAME in json.dumps(item['payload'])):
            raise video.ApprovalRequired('เงื่อนไข fal ของ UGC ไม่ตรงกับฉาก')


FIT = ('scale=1080:1920:force_original_aspect_ratio=decrease,'
       'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x101421,setsar=1')
FORMATS = {'image/jpeg':('image2','.jpg'),'image/png':('image2','.png'),
           'image/webp':('image2','.webp'),'video/mp4':('mov','.mp4')}


def local_ffmpeg(args):
    subprocess.run(['ffmpeg','-v','error','-y','-threads','2','-filter_threads','2',*args],
                   timeout=120,check=True,capture_output=True)


def prepare_media(ctx, media, needs_fal, reference_store):
    codec, suffix = FORMATS[media['content_type']]
    key = media['storage_key']
    path = ctx.path('product',media['id']+suffix)
    if key.startswith('ugc-r2/'):
        if not Path(path).exists():
            reference_store.get_file(key,path)
    else:
        ctx.fetch(key,path)
    src = ['-protocol_whitelist','file','-f',codec]
    if codec == 'image2':
        src+=['-pattern_type','none']
    elif codec == 'mov':
        src+=['-enable_drefs','0','-use_absolute_path','0']
    src+=['-i',path]
    # Inspect/decode the exact owner media before dispatching any paid request.
    log = subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=width,height:format=duration','-of','json',*src],
        timeout=20,stderr=subprocess.DEVNULL)
    metadata = json.loads(log)
    info = metadata.get('streams',[{}])[0]
    if not (0 < info.get('width',0) <= 8192 and 0 < info.get('height',0) <= 8192
            and info['width']*info['height'] <= 28_000_000):
        raise video.ApprovalRequired('ขนาดภาพสินค้าไม่รองรับ')
    if codec == 'mov':
        length = float(metadata.get('format',{}).get('duration',0))
        if not math.isfinite(length) or not 0 < length <= 180:
            raise video.ApprovalRequired('วิดีโอสินค้าต้องสั้นกว่า 3 นาที')
    # A stable address is part of the existing fal idempotency payload.
    ref = ctx.path('refs',media['id']+'.jpg')
    local_ffmpeg([*src,'-an','-vf',FIT,'-frames:v','1','-q:v','2',ref])
    key = 'ugc-frames/v1/'+media['id']+'.jpg'
    if needs_fal and not reference_store.exists(key):
        reference_store.put_file(key,ref,'image/jpeg')
    return src, ref, key


def original_clip(ctx, shot, source):
    src, ref, _ = source
    dest = ctx.path('product-shots',shot['id']+'.mp4')
    if shot['seconds']<2:
        raise video.ApprovalRequired('ช่วงแสดงสินค้าสั้นเกินไป')
    image = src[src.index('-f')+1]=='image2'
    stream = ['-loop','1','-framerate','30','-i',ref] if image else src
    local_ffmpeg([*stream,'-map','0:v:0','-an','-vf',
        FIT+',fps=30,tpad=stop_mode=clone:stop_duration='+str(shot['seconds']),
        '-t',str(shot['seconds']),'-c:v','libx264','-threads','2','-preset','fast','-pix_fmt','yuv420p',dest])
    return dest


def overlay(T, path, details, last_seconds):
    video.subtitle_ass(T,path)
    safe = lambda text: re.sub(r'[\\{}\r\n]',' ',text)
    def stamp(seconds):
        ticks=round(seconds*100)
        return f'{ticks//360000}:{ticks//6000%60:02}:{ticks//100%60:02}.{ticks%100:02}'
    def event(start,text,y,size):
        return f'Dialogue: 1,{stamp(start)},{stamp(T["end"])},Default,,0,0,0,,{{\\an8\\pos(540,{y})\\fs{size}\\bord7}}{safe(text)}\n'
    start = T['end']-last_seconds
    labels = []
    if details['price']:
        labels.append(event(0,details['price']+' บาท',125,80))
    if details['promo']:
        from pythainlp.tokenize import word_tokenize
        capped = ['']
        for word in word_tokenize(details['promo'],engine='newmm'):
            while len(word)>25:
                if capped[-1]:
                    capped.append('')
                capped[-1], word=word[:25],word[25:]
                capped.append('')
            if len(capped[-1])+len(word)>25:
                capped.append('')
            capped[-1]+=word
        promo='\\N'.join(safe(x.strip()) for x in capped if x.strip())
        labels.append(event(start,'__PROMO__',345,48).replace('__PROMO__',promo))
    cta=safe(details['cta'])
    labels.append(event(start,cta,224,58))
    with open(path,'a',encoding='utf-8') as file:
        file.writelines(labels)


def run(ctx):
    from engine.core import FD
    video.check_active(ctx)
    spec = video.validate(ctx)
    shots = spec['plan']['shots']
    refs = {s['media_id'] for s in shots if s['mode']=='fal'}
    try:
        reference_store = r2.ugc_references()
        media = {m['id']:prepare_media(ctx,m,m['id'] in refs,reference_store) for m in ctx.pkg['ugc']['media']}
    except (subprocess.SubprocessError,ValueError,IndexError,KeyError,r2.R2Error) as e:
        raise video.ApprovalRequired('เปิดสื่อสินค้าไม่ได้ ตรวจไฟล์แล้วอัปโหลดใหม่ก่อนผลิต') from e
    voices = []
    for i, shot in enumerate(shots):
        ctx.db.status(ctx.job,'GENERATING_AUDIO','GENERATING_AUDIO',.05+i/len(shots)*.2,
            f'เสียงไทยฉาก {i+1}/{len(shots)}',{'scene_id':shot['id'],'state':'voice'})
        v = video.narration(ctx,shot,i)
        src = ctx.fetch(v['audio_key'],ctx.path('voice',shot['id']+'.mp3'))
        if audio.duration(src)>max(.1,shot['seconds']-.2)*1.2:
            raise video.ApprovalRequired(f'เสียงฉาก {i+1} ยาวเกินช่วงตัดต่อ กรุณาย่อบท')
        voices.append(v)
    clips = []
    for i, shot in enumerate(shots):
        video.check_active(ctx)
        ctx.db.status(ctx.job,'RENDERING','RENDERING',.25+i/len(shots)*.5,
            f'กำลังทำฉาก {i+1}/{len(shots)}',{'scene_id':shot['id'],'state':'rendering'})
        source = media[shot['media_id']]
        if shot['mode']=='original':
            clip = original_clip(ctx,shot,source)
        else:
            item = video.scene_items(spec,shot)[0]
            result = video.fal_shot(ctx,shot,i,source[2],item,reference_store=reference_store)
            padded = (item.get('billed_seconds') or 0)>item['generation_seconds']
            over_duration = padded and (result.get('generated_duration') or 0)>item['billed_seconds']+.04
            over_cost = result.get('actual_usd') is not None and result['actual_usd']>item['estimated_usd']+1e-6
            if (over_duration or over_cost) and item['slot'] in spec['approval']['pending_slots']:
                raise video.ApprovalRequired('ผลจาก fal ใช้วินาทีหรือค่าใช้จ่ายเกินใบราคา เก็บฉากแล้วและหยุดก่อนส่งฉากต่อไป')
            clip = ctx.fetch(result['video_key'],ctx.path('fal',shot['id']+'.mp4'))
        clips.append(clip)
        ctx.db.event(ctx.job['id'],f'ฉาก {i+1} พร้อมประกอบ',{'scene_id':shot['id'],'state':'done'},status='RENDERING')
    voice,T = video.build_voice(ctx,voices)
    elapsed = 0
    overrides = {}
    for shot in shots:
        if shot.get('subtitle'):
            overrides[shot['id']] = video.editorial_caption(
                {**shot,'narration':shot['subtitle']},elapsed,shot['seconds'])
        elapsed += shot['seconds']
    if overrides:
        T['timeline'] = [overrides.get(seg['id'],seg) for seg in T['timeline']]
    silent = rendering.concat(clips,ctx.path('video_silent.mp4'))
    captions = ctx.path('ugc-captions.ass')
    overlay(T,captions,ctx.pkg['ugc']['export'],shots[-1]['seconds'])
    output = ctx.path('ugc.mp4')
    local_ffmpeg(['-i',silent,'-i',voice,'-vf',f'ass={captions}:fontsdir={FD}','-t',str(T['end']),
        '-map','0:v:0','-map','1:a:0','-c:v','libx264','-threads','2','-preset','fast','-pix_fmt','yuv420p',
        '-c:a','aac','-movflags','+faststart',output])
    info = audio.ffprobe(output)
    duration = float(info['format']['duration'])
    width,height = next(((s['width'],s['height']) for s in info['streams'] if s['codec_type']=='video'),(0,0))
    if not (T['end']-.1 <= duration <= 30 and (width,height)==(1080,1920) and
            any(s['codec_type']=='audio' for s in info['streams'])):
        raise video.ApprovalRequired('MP4 ไม่ผ่านการตรวจความยาว ขนาดภาพ หรือแทร็กเสียง')
    video.check_active(ctx)
    key = ctx.save('video',output,ctx.prefix+'/ugc/final.mp4','video/mp4')
    ctx.save('captions',captions,ctx.prefix+'/ugc/subtitles.ass','text/x-ssa')
    result = {'final_key':key,'duration':duration,'width':width,'height':height}
    ctx.db.q("UPDATE jobs SET result=%s::jsonb,error=NULL WHERE id=%s AND status <> 'CANCELLED'",
             (json.dumps(result),ctx.job['id']))
    ctx.db.status(ctx.job,'READY_TO_POST','READY_TO_POST',1,'UGC AI พร้อมดาวน์โหลด')
    ctx.db.release(ctx.job)
    return result
