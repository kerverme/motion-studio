"""UGC queue consumer. Reuses Studio's receipt ledger, fal client and Thai narration."""
import json
import math
import re
import subprocess
import time

import numpy as np
from pathlib import Path

from . import audio, r2, rendering, text_video as video


IMAGE_MODELS = {'fal-ai/nano-banana-pro/edit','fal-ai/nano-banana-2/edit'}
IMAGE_REFERENCES = ['https://studio.cloudbath.co/internal/ugc-product.png','https://studio.cloudbath.co/internal/ugc-presenter.png']


def validate_image(ctx, spec):
    approval = spec['approval']
    image = ctx.pkg['ugc']['image']
    items, media = approval['fal'], approval['media']
    if not (spec['version']==2 and spec['input'].get('ugc') is True and len(items)==1 and len(media) in (1,2)
            and approval['basis']==image['basis'] and not approval['eleven'] and approval['pending_slots']==['fal:opening_image']
            and approval['payload_hash']==video.canonical_hash({'fal':items,'eleven':[]})):
        raise video.ApprovalRequired('ใบราคาเฟรมเปิดไม่ตรงกับสื่อที่ยืนยัน')
    item = items[0]
    wire = item['payload']
    expected = {'image_urls':IMAGE_REFERENCES[:len(media)],'num_images':1,'resolution':'1K',
                'aspect_ratio':'9:16','output_format':'jpeg','enable_web_search':False}
    if not (item['endpoint_id'] in IMAGE_MODELS and item['slot']=='fal:opening_image' and item['estimated_usd']>0
            and set(wire)==set(expected)|{'prompt'} and all(wire[k]==v for k,v in expected.items())
            and media[0]['role']=='product' and (len(media)==1 or media[1]['role']=='presenter')
            and all(m['kind']=='image' and m['storage_key'].startswith('ugc-r2/') for m in media)):
        raise video.ApprovalRequired('คำขอภาพเปิดไม่ตรงกับโมเดลหรือสื่อที่อนุมัติ')


def validate_production(ctx, spec):
    approval = spec['approval']
    ugc = ctx.pkg['ugc']
    shots = spec['plan']['shots']
    seconds = spec['input']['duration']
    media = ugc['media']
    fal, voice = approval['fal'], approval['eleven']
    presenter = spec['input'].get('presenter') is True
    ends = {shots[0]['id'], shots[-1]['id']} if presenter else set()
    ending_matches = (len(shots)>=3 and shots[0]['seconds']==3 and
        shots[0]['mode']==shots[-1]['mode']=='fal' and shots[0]['media_id']==shots[-1]['media_id']) if presenter else (
        3<=shots[0]['seconds']<=5 and shots[0]['mode']==shots[-1]['mode']=='original')
    if not (spec['input'].get('ugc') is True and type(seconds) is int and 8 <= seconds <= 30
            and 2 <= len(shots) <= 10 and ending_matches
            and all(type(s['seconds']) is int and 2 <= s['seconds'] <= 15 for s in shots)
            and sum(s['seconds'] for s in shots) == seconds
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
            or len(voice_slots) != len(shots)-len(ends)):
        raise video.ApprovalRequired('จำนวนรายการค่าใช้จ่าย UGC ไม่ตรงกับฉาก')
    for s in shots:
        if s['media_id'] not in sources or s['mode'] not in ('fal','original'):
            raise video.ApprovalRequired('ไม่พบสื่อตามที่อนุมัติในฉาก '+s['id'])
        v = voice_slots.get('eleven:'+s['id'])
        speaking = s['id'] in ends
        role = sources[s['media_id']].get('role','product')
        if presenter and (role not in ('frame','opening') if speaking else role!='product'):
            raise video.ApprovalRequired('สื่อที่อนุมัติไม่ตรงบทบาทของฉาก '+s['id'])
        if (speaking and v) or (not speaking and not (v and v['text']==s['narration'] and v['voice_id']==ctx.pkg['voice']['voice_id']==approval['voice_id']
                and v['model_id']==ctx.pkg['voice']['model_id']==approval['voice_model'])):
            raise video.ApprovalRequired('บทหรือเสียง UGC เปลี่ยนหลังอนุมัติ')
        if s['mode']=='original':
            continue
        item = paid.get('fal:'+s['id'])
        endpoint = item.get('endpoint_id','') if item else ''
        if not (item and '/image-to-video' in endpoint and re.fullmatch(r'[\w.-]+(?:/[\w.-]+)+',endpoint,re.ASCII)
                and not set(endpoint.split('/')) & {'.','..'}
                and item['media_id']==s['media_id'] and item['edited_seconds']==s['seconds']
                and s['seconds']<=item['generation_seconds']<=30
                and item['estimated_usd']>0 and item['native_audio'] is speaking
                and (not speaking or item.get('narration')==s['narration'])
                and video.PREVIOUS_FRAME in json.dumps(item['payload'])):
            raise video.ApprovalRequired('เงื่อนไข fal ของ UGC ไม่ตรงกับฉาก')


def fit_filter(width=1080,height=1920):
    return (f'scale={width}:{height}:force_original_aspect_ratio=decrease,'
            f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x101421,setsar=1')
FORMATS = {'image/jpeg':('image2','.jpg'),'image/png':('image2','.png'),
           'image/webp':('image2','.webp'),'video/mp4':('mov','.mp4')}


def local_ffmpeg(args):
    subprocess.run(['ffmpeg','-v','error','-y','-threads','2','-filter_threads','2',*args],
                   timeout=120,check=True,capture_output=True)


def prepare_media(ctx, media, needs_fal, reference_store, frame_seconds=None):
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
    if frame_seconds is not None and (codec!='mov' or not 0<=frame_seconds<length):
        raise video.ApprovalRequired('เลือกตำแหน่งเฟรมภายในคลิปคนรีวิว')
    seek = ['-ss',str(frame_seconds)] if frame_seconds is not None else []
    local_ffmpeg([*src,*seek,'-an','-vf',fit_filter(),'-frames:v','1','-q:v','2',ref])
    if not Path(ref).is_file():
        raise video.ApprovalRequired('ไม่พบเฟรมในตำแหน่งที่เลือก')
    key = 'ugc-frames/v1/'+media['id']+'.jpg'
    if needs_fal and not reference_store.exists(key):
        reference_store.put_file(key,ref,'image/jpeg')
    return src, ref, key


def original_clip(ctx, shot, source, size):
    src, ref, _ = source
    dest = ctx.path('product-shots',shot['id']+'.mp4')
    if shot['seconds']<2:
        raise video.ApprovalRequired('ช่วงแสดงสินค้าสั้นเกินไป')
    image = src[src.index('-f')+1]=='image2'
    stream = ['-loop','1','-framerate','30','-i',ref] if image else src
    local_ffmpeg([*stream,'-map','0:v:0','-an','-vf',
        fit_filter(*size)+',fps=30,tpad=stop_mode=clone:stop_duration='+str(shot['seconds']),
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


def save_opening(ctx, path, role, details, opening, store):
    draft = ctx.pkg['ugc']['draft_id']
    media_id = opening['media_id']
    key = f'ugc-r2/v1/openings/{draft}/{media_id}.jpg'
    if not store.exists(key):
        store.put_file(key,path,'image/jpeg')
    ctx.db.q('''INSERT INTO ugc_media(id,draft_id,kind,content_type,storage_key,bytes,role,details)
               VALUES(%s,%s,'image','image/jpeg',%s,%s,%s,%s::jsonb) ON CONFLICT(id) DO NOTHING''',
             (media_id,draft,key,Path(path).stat().st_size,role,json.dumps(details)))
    return {'media_id':media_id}


def finish_opening(ctx, result):
    video.check_active(ctx)
    ctx.db.q("UPDATE jobs SET result=%s::jsonb,error=NULL WHERE id=%s AND status<>'CANCELLED'",
             (json.dumps(result),ctx.job['id']))
    ctx.db.status(ctx.job,'READY_TO_POST','READY_TO_POST',1,'เฟรมคนถือสินค้าพร้อมตรวจ')
    ctx.db.release(ctx.job)
    return result


def extract_opening(ctx):
    video.check_active(ctx)
    frame=ctx.pkg['ugc']['frame']
    source,seconds=frame['source'],frame['seconds']
    if not (source['role']=='presenter' and source['kind']=='video' and source['storage_key'].startswith('ugc-r2/')):
        raise video.ApprovalRequired('ไฟล์ต้นทางไม่ใช่คลิปคนรีวิว')
    store=r2.ugc_references()
    ctx.db.status(ctx.job,'RENDERING','RENDERING',.2,'กำลังตัดเฟรมจากคลิปคนรีวิว')
    _,ref,_=prepare_media(ctx,source,False,store,seconds)
    return finish_opening(ctx,save_opening(ctx,ref,'frame',{'source_id':source['id'],'seconds':seconds},frame,store))


def generate_opening(ctx):
    video.check_active(ctx)
    spec=video.validate(ctx)
    approval=spec['approval']
    item=approval['fal'][0]
    store=r2.ugc_references()
    for medium in approval['media']:
        prepare_media(ctx,medium,False,store)
    ctx.db.status(ctx.job,'RENDERING','RENDERING',.2,'กำลังเตรียมเฟรมคนถือสินค้า')
    keys=[m['storage_key'] for m in approval['media']]
    logical={'endpoint':item['endpoint_id'],'payload':item['payload'],'media':keys}
    row,send=video.reserve(ctx,item['slot'],'fal',logical)
    if row['status']=='done':
        return finish_opening(ctx,row['data']['result'])
    if send:
        wire={**item['payload'],'image_urls':[store.signed_url(key,86400) for key in keys]}
        _,receipt=video.paid_post(ctx,row,'https://queue.fal.run/'+item['endpoint_id'],video.fal_headers(),wire,60)
        request_id=receipt.get('request_id')
        try:
            if not isinstance(request_id,str) or not request_id:
                raise video.ApprovalRequired('fal ไม่คืน request ID ของภาพ')
            data={k:video.queue_url(receipt.get(k)) for k in ('status_url','response_url')}
        except video.ApprovalRequired:
            video.update(ctx,row,'unknown',{'error':'Missing or invalid fal image receipt'},request_id if isinstance(request_id,str) else None)
            raise
        video.update(ctx,row,'accepted',data,request_id)
    deadline=time.monotonic()+1800
    while time.monotonic()<deadline:
        video.check_active(ctx)
        response=video.requests.get(video.queue_url(row['data']['status_url']),headers=video.fal_headers(),timeout=30,allow_redirects=False)
        response.raise_for_status()
        state=response.json().get('status')
        if state in ('FAILED','CANCELLED','CANCELED'):
            video.update(ctx,row,'failed',{**row['data'],'error':state})
            raise video.ApprovalRequired('fal สร้างภาพเปิดไม่สำเร็จ ขอราคาใหม่ก่อนลองอีกครั้ง')
        if state=='COMPLETED':
            response=video.requests.get(video.queue_url(row['data']['response_url']),headers=video.fal_headers(),timeout=60,allow_redirects=False)
            if response.status_code in (404,408,409,425,429) or response.status_code>=500:
                raise RuntimeError('ผลภาพยังไม่พร้อม จะตรวจ request ID เดิม')
            payload=response.json() if response.ok else {}
            images=payload.get('images') or []
            if len(images)!=1 or not images[0].get('url'):
                video.update(ctx,row,'failed',{**row['data'],'error':'Missing approved image'})
                raise video.ApprovalRequired('fal ไม่คืนภาพเปิดหนึ่งภาพตามที่อนุมัติ')
            raw,ref=ctx.path('opening-source.jpg'),ctx.path('opening.jpg')
            video.download_video(images[0]['url'],raw,max_bytes=20*1024*1024)
            local_ffmpeg(['-protocol_whitelist','file','-f','image2','-pattern_type','none','-i',raw,
                          '-vf',fit_filter(),'-frames:v','1','-q:v','2',ref])
            opening=ctx.pkg['ugc']['image']
            actual=video.reported_cost_usd(payload)
            result=save_opening(ctx,ref,'opening',{'basis':opening['basis'],'estimated_usd':item['estimated_usd'],
                'actual_usd':actual,'model':item['model_name']},opening,store)
            video.update(ctx,row,'done',{**row['data'],'result':result,'actual_usd':actual})
            return finish_opening(ctx,result)
        time.sleep(4)
    raise RuntimeError('fal ยังเตรียมภาพอยู่ จะตรวจ request ID เดิม')


def compare_first_frame(approved, rendered):
    # Luminance detects a large framing change. It does not recognize people, logos or lips.
    def pixels(path):
        result=subprocess.check_output(['ffmpeg','-v','error','-threads','1','-i',path,
            '-vf','scale=32:56,format=gray','-frames:v','1','-f','rawvideo','-'],timeout=15)
        return np.frombuffer(result,dtype=np.uint8).astype(np.float32)
    expected,observed=pixels(approved),pixels(rendered)
    if expected.shape!=observed.shape or expected.size!=32*56:
        return True
    return bool(np.mean(np.abs(expected-observed))>32)


def run(ctx):
    from engine.core import FD
    if ctx.pkg['ugc'].get('frame'):
        return extract_opening(ctx)
    if ctx.pkg['ugc'].get('image'):
        return generate_opening(ctx)
    video.check_active(ctx)
    spec = video.validate(ctx)
    shots = spec['plan']['shots']
    presenter=spec['input'].get('presenter') is True
    speakers={shots[0]['id'],shots[-1]['id']} if presenter else set()
    refs = {s['media_id'] for s in shots if s['mode']=='fal' and s['id'] not in speakers}
    by_id={m['id']:m for m in ctx.pkg['ugc']['media']}
    try:
        reference_store = r2.ugc_references()
        media = {m['id']:prepare_media(ctx,m,m['id'] in refs,reference_store) for m in ctx.pkg['ugc']['media']}
    except (subprocess.SubprocessError,ValueError,IndexError,KeyError,r2.R2Error) as e:
        raise video.ApprovalRequired('เปิดสื่อสินค้าไม่ได้ ตรวจไฟล์แล้วอัปโหลดใหม่ก่อนผลิต') from e
    voices = []
    for i, shot in enumerate(shots):
        if shot['id'] in speakers:
            voices.append(None)
            continue
        ctx.db.status(ctx.job,'GENERATING_AUDIO','GENERATING_AUDIO',.05+i/len(shots)*.2,
            f'เสียงไทยฉาก {i+1}/{len(shots)}',{'scene_id':shot['id'],'state':'voice'})
        v = video.narration(ctx,shot,i)
        src = ctx.fetch(v['audio_key'],ctx.path('voice',shot['id']+'.mp3'))
        if audio.duration(src)>max(.1,shot['seconds']-.2)*1.2:
            raise video.ApprovalRequired(f'เสียงฉาก {i+1} ยาวเกินช่วงตัดต่อ กรุณาย่อบท')
        voices.append(v)
    clips = []
    size=video.output_size(spec)
    native, previews, checks = {}, {}, {}
    for i, shot in enumerate(shots):
        video.check_active(ctx)
        ctx.db.status(ctx.job,'RENDERING','RENDERING',.25+i/len(shots)*.5,
            f'กำลังทำฉาก {i+1}/{len(shots)}',{'scene_id':shot['id'],'state':'rendering'})
        source = media[shot['media_id']]
        if shot['mode']=='original':
            clip = original_clip(ctx,shot,source,size)
        else:
            item = video.scene_items(spec,shot)[0]
            speaking=shot['id'] in speakers
            frame_key=by_id[shot['media_id']]['storage_key'] if speaking else source[2]
            try:
                result = video.fal_shot(ctx,shot,i,frame_key,item,reference_store=reference_store)
            except video.ApprovalRequired:
                if presenter:
                    ctx.db.event(ctx.job['id'],f'ฉาก {i+1} ต้องตรวจ',
                                 {'scene_id':shot['id'],'state':'review'},status='RENDERING')
                raise
            padded = (item.get('billed_seconds') or 0)>item['generation_seconds']
            over_duration = padded and (result.get('generated_duration') or 0)>item['billed_seconds']+.04
            over_cost = result.get('actual_usd') is not None and result['actual_usd']>item['estimated_usd']+1e-6
            if (over_duration or over_cost) and item['slot'] in spec['approval']['pending_slots']:
                raise video.ApprovalRequired('ผลจาก fal ใช้วินาทีหรือค่าใช้จ่ายเกินใบราคา เก็บฉากแล้วและหยุดก่อนส่งฉากต่อไป')
            clip = ctx.fetch(result['video_key'],ctx.path('fal',shot['id']+'.mp4'))
            if speaking:
                raw=ctx.fetch(result['raw_key'],ctx.path('fal',shot['id']+'_audio_source.mp4'))
                try:
                    speech=ctx.path('voice',shot['id']+'_native.wav')
                    local_ffmpeg(['-i',raw,'-vn','-t',str(shot['seconds']),'-af','apad',
                                  '-map','0:a:0','-ac','2','-ar','48000',speech])
                    if float(np.max(np.abs(audio.decode(speech))))<.006:
                        raise ValueError('silent track')
                except (ValueError,subprocess.SubprocessError) as error:
                    ctx.db.event(ctx.job['id'],'ฉากนี้ไม่มีเสียงพูดที่ได้ยิน',{'scene_id':shot['id'],'state':'review'},status='RENDERING')
                    raise video.ApprovalRequired(f'ฉาก {i+1} ไม่มีเสียงพูดที่ได้ยิน กรุณาตรวจและแก้เฉพาะฉากนี้') from error
                native[shot['id']]=speech
        if presenter:
            preview=ctx.path('review',shot['id']+'.jpg')
            local_ffmpeg(['-i',clip,'-frames:v','1','-q:v','3',preview])
            if shot['id'] in speakers:
                checks[shot['id']]={'frame_review':compare_first_frame(source[1],preview),'non_silent_audio':True}
            previews[shot['id']]=ctx.save('ugc_scene_preview',preview,ctx.prefix+'/ugc/review/'+shot['id']+'.jpg','image/jpeg')
        clips.append(clip)
        ctx.db.event(ctx.job['id'],f'ฉาก {i+1} พร้อมประกอบ',{'scene_id':shot['id'],'state':'done'},status='RENDERING')
    voice,T = video.build_voice(ctx,voices,native=native)
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
    if not (T['end']-.1 <= duration <= 30 and (width,height)==size and
            any(s['codec_type']=='audio' for s in info['streams'])):
        raise video.ApprovalRequired('MP4 ไม่ผ่านการตรวจความยาว ขนาดภาพ หรือแทร็กเสียง')
    video.check_active(ctx)
    key = ctx.save('video',output,ctx.prefix+'/ugc/final.mp4','video/mp4')
    ctx.save('captions',captions,ctx.prefix+'/ugc/subtitles.ass','text/x-ssa')
    result = {'final_key':key,'duration':duration,'width':width,'height':height,'scene_previews':previews,'scene_checks':checks}
    ctx.db.q("UPDATE jobs SET result=%s::jsonb,error=NULL WHERE id=%s AND status <> 'CANCELLED'",
             (json.dumps(result),ctx.job['id']))
    ctx.db.status(ctx.job,'READY_TO_POST','READY_TO_POST',1,'UGC AI พร้อมดาวน์โหลด')
    ctx.db.release(ctx.job)
    return result
