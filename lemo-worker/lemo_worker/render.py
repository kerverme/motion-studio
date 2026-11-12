import io, json, os, subprocess, tarfile
from pathlib import Path
import requests
from motion_worker import pipeline, rendering, timeline
from motion_worker.creative_ledger import digest, cached_call, Ledger
from .coding import generate_scene


def extract(data, folder):
    allowed={'video.mp4','preview-0.png','preview-1.png','preview-2.png','metadata.json'}
    if len(data)>96*1024*1024:raise ValueError('Renderer output too large')
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        members=archive.getmembers()
        if {m.name for m in members}!=allowed or len(members)!=len(allowed) or any(not m.isfile() or m.size>96*1024*1024 for m in members):raise ValueError('Unsafe renderer archive')
        Path(folder).mkdir(parents=True,exist_ok=True)
        for member in members:(Path(folder)/member.name).write_bytes(archive.extractfile(member).read())


def remote_render(spec, folder):
    url=os.environ['LEMO_EXECUTOR_URL'].rstrip('/')
    if not url.startswith('https://') and os.environ.get('LEMO_DEVELOPMENT')!='true':raise RuntimeError('Executor requires authenticated TLS')
    with requests.post(url+'/render',json=spec,headers={'Authorization':'Bearer '+os.environ['LEMO_EXECUTOR_TOKEN']},timeout=(15,330),stream=True) as r:
        if not r.ok:raise RuntimeError('Renderer: '+r.text[:1800])
        data=bytearray()
        for chunk in r.iter_content(65536):
            data.extend(chunk)
            if len(data)>96*1024*1024:raise RuntimeError('Renderer output limit')
    extract(bytes(data),folder)


def stage_render(ctx, render=remote_render, code=generate_scene):
    T=pipeline.load_timeline(ctx);creative=ctx.pkg['creative']
    partial=ctx.r.get('LEMO_RENDER',{'scenes':[]});done={s['seg']:s for s in partial['scenes']};parts=[]
    for i,scene in enumerate(creative['selection']['plan']['scenes']):
        seg=T['timeline'][i];start=0 if i==0 else seg['s'];end=T['timeline'][i+1]['s'] if i+1<len(T['timeline']) else T['end'];duration=end-start
        identity=digest({'scene':scene,'identity':creative['selection']['plan']['identity'],'script':ctx.pkg['script'][i],'duration':duration,'nonce':creative.get('scene_nonces',{}).get(scene['seg'])})
        previous=done.get(scene['seg'])
        if previous and previous['identity']==identity:
            parts.append(ctx.fetch(previous['video_key'],ctx.path('renders',identity,'video.mp4')));continue
        folder=ctx.path('renders',identity);error=None
        for attempt in range(2):
            source=code(ctx,scene,duration,attempt,error)
            html=Path(ctx.fetch(source['source_key'],ctx.path('source',identity+f'-{attempt}.html'))).read_text()
            try:
                cap=creative['allocations']['compute']/(len(T['timeline'])*2)
                def run(_reservation):
                    render({'html':html,'duration':duration,'width':1080,'height':1920,'fps':30},folder)
                    artifacts={}
                    for name,kind in [('video.mp4','scene_video'),('preview-0.png','preview'),('preview-1.png','preview'),('preview-2.png','preview'),('metadata.json','render_metadata')]:
                        artifacts[name]=ctx.save(kind,str(Path(folder)/name),f'{ctx.prefix}/lemo/{identity}/{name}',meta={'seg':scene['seg']})
                    return {'artifacts':artifacts,'asset_keys':list(artifacts.values()),'usage':json.loads((Path(folder)/'metadata.json').read_text())}
                rendered=cached_call(ctx,'compute','canvas2d',{'identity':identity,'attempt':attempt,'source_key':source['source_key'],'renderer_image':os.environ.get('LEMO_SANDBOX_IMAGE')},cap,run)
                for name,key in rendered['artifacts'].items():ctx.fetch(key,str(Path(folder)/name))
                break
            except Exception as exc:
                # Never silently spend a second code attempt after a render failure.
                # Preserve source/paid assets; owner can inspect and explicitly regenerate.
                raise RuntimeError(f"Scene {scene['seg']} failed ({type(exc).__name__}): {str(exc)[:1800]}; source retained for targeted repair") from exc
        item={'seg':scene['seg'],'identity':identity,'source_key':source['source_key'],'video_key':rendered['artifacts']['video.mp4'],'previews':[rendered['artifacts'][f'preview-{j}.png'] for j in range(3)],'metadata':rendered['usage'],'provenance':source.get('provenance',{})}
        done[scene['seg']]=item;partial={'scenes':list(done.values())};ctx.db.save_stage(ctx.job,'LEMO_RENDER',partial)
        ctx.db.status(ctx.job,'RENDERING','RENDERING',.25+.5*(i+1)/len(T['timeline']),f"Lemo rendered {i+1}/{len(T['timeline'])}")
        parts.append(str(Path(folder)/'video.mp4'))
    def compose(_reservation):
        import time
        started=time.monotonic()
        raw=rendering.concat(parts,ctx.path('raw.mp4'))
        subs=ctx.path('subtitles.srt');Path(subs).write_text(timeline.srt(T['timeline'],T['end']))
        silent=ctx.path('video_silent.mp4')
        subprocess.run(['ffmpeg','-v','error','-y','-i',raw,'-vf',f"subtitles={subs}:force_style='Fontname=Noto Sans Thai,Fontsize=16,Outline=2,MarginV=26'",'-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-r','30',silent],check=True,timeout=300)
        mix,*_=pipeline.do_mix(ctx,T);final=rendering.mux(silent,mix,ctx.path('final.mp4'))
        return {'silent_key':ctx.save('video_silent',silent),'final_key':ctx.save('video',final),'missing_words':[],'frames':round(T['end']*30),'usage':{'wall_seconds':time.monotonic()-started}}
    return Ledger(ctx).execute('lemo-composition-v1','infrastructure','ffmpeg','compute',{'scenes':[s['identity'] for s in partial['scenes']],'timeline':T},creative['allocations']['compute']/2,compose)
