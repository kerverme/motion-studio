"""Real Classic/Canvas rendering with mocked AI/Eleven responses. No paid calls.

Only the three committed fixture HTML hashes may bypass unavailable dev cgroups.
This is NOT a successful security gate or a real-provider quality evaluation.
"""
import base64, json, os, subprocess, sys, time
from pathlib import Path
from unittest.mock import patch
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'worker'),str(ROOT/'lemo-worker/sandbox')]
from executor import run,validate_archive
from motion_worker import audio,eleven,timeline,rendering,qa


def tone(duration,frequency):
    return subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i',f'sine=frequency={frequency}:duration={duration}','-af','volume=1.5','-c:a','libmp3lame','-f','mp3','-'])


def classic_source(kind):
    return '''import math
from engine import core
KIND=KIND_VALUE
def draw(img,d,t):
    n=min(3,int(t/2));p=t%2
    title=core.text_img(['คำถาม','ลองสังเกต','เรื่องกำลังเปลี่ยน','บทสรุป'][n],76,700)
    img.alpha_composite(title,((1080-title.width)//2,280))
    if KIND=='nik':
        for i in range(5):
            x=160+i*185;y=740+int(25*math.sin(t*2+i))
            d.ellipse((x-40,y-40,x+40,y+40),fill='#55d6c2');d.rounded_rectangle((x-45,y+55,x+45,y+200),20,fill='#55d6c2')
        q=core.text_img('ยังไม่ทราบ' if n==3 else '?',120,800);img.alpha_composite(q,((1080-q.width)//2,1150))
    elif KIND=='dream':
        d.ellipse((730,430,900,600),fill='#fff3bb');d.rectangle((200,1080,880,1190),fill='#476659');d.ellipse((240,980,370,1110),fill='#d2dc72');d.rectangle((390,1020,790,1100),fill='#d2dc72')
        for i in range(80):
            x=540+int(math.cos(i*.73+p*.6)*210);y=800+int(math.sin(i*.73+p*.6)*170)
            d.ellipse((x-4,y-4,x+4,y+4),fill='#d2dc72')
    else:
        dy=int(math.sin(t*5)*12)
        d.ellipse((360,900+dy,700,1250+dy),fill='#24354a');d.ellipse((350,700+dy,710,1020+dy),fill='#ffaf69')
        d.polygon([(350,790+dy),(350,610+dy),(470,740+dy)],fill='#ffaf69');d.polygon([(590,740+dy),(710,610+dy),(710,790+dy)],fill='#ffaf69')
        for x in [455,595]:d.ellipse((x-15,820+dy,x+15,850+dy),fill='#24354a')
        d.arc((495,865+dy,555,920+dy),0,180,fill='#24354a',width=7);d.rectangle((230,1300,880,1335),fill='#ffaf69')
SCENES={s:(draw,((16,43,70),(28,55,80))) for s in ['s1','s2','s3','s4']}
'''.replace('KIND_VALUE',repr(kind))


def main():
    output=Path(sys.argv[1] if len(sys.argv)>1 else '/workspace/output/lemo-comparison');output.mkdir(parents=True,exist_ok=True)
    image=subprocess.check_output(['docker','image','inspect','cloudbath-lemo-sandbox:dev','--format','{{.Id}}'],text=True).strip()
    report={'mock_providers':True,'real_provider_calls':0,'ai_usage':{'input_tokens':0,'output_tokens':0,'note':'Semantic scores and source are fixtures, not live AI evaluation'},'cost_usd':{'providers':0,'render_infrastructure':None},'resource_enforcement_verified':False,'stories':[]}
    for kind in ['nik','dream','cats']:
        fixture=json.loads((Path(__file__).parent/'fixtures'/f'{kind}.json').read_text());folder=output/kind;folder.mkdir(exist_ok=True)
        chars=[];starts=[];ends=[]
        for i,seg in enumerate(fixture['script']):
            if chars:chars.append(' ');starts.append(i*2);ends.append(i*2)
            for j,char in enumerate(seg['text']):chars.append(char);starts.append(i*2+.08+j*1.7/len(seg['text']));ends.append(i*2+.08+(j+1)*1.7/len(seg['text']))
        alignment={'characters':chars,'character_start_times_seconds':starts,'character_end_times_seconds':ends}
        vo_bytes=tone(8,220);fx_bytes=tone(.5,880)
        def mock_post(path,body,*args,**kwargs):
            if path=='/v1/text-to-dialogue/with-timestamps':
                assert body['model_id']=='eleven_v4'
                return {'audio_base64':base64.b64encode(vo_bytes).decode(),'normalized_alignment':alignment,'voice_segments':[{'voice_id':'mock-existing-voice','start_time_seconds':0,'end_time_seconds':8,'character_start_index':0,'character_end_index':len(chars),'dialogue_input_index':0}]},{'request_id':'mock-voice','character_cost':len(chars),'mock':True}
            assert path=='/v1/sound-generation' and body['model_id']=='eleven_text_to_sound_v3'
            return fx_bytes,{'request_id':'mock-sfx','mock':True}
        with patch.object(eleven,'_post',side_effect=mock_post):
            vo,al,metadata=eleven.tts_with_timestamps(' '.join(s['text'] for s in fixture['script']),'mock-existing-voice')
            fx,fxmeta=eleven.sound_effect('gentle wood click',.5,model_id='eleven_text_to_sound_v3')
        (folder/'narration-mock.mp3').write_bytes(vo);(folder/'sfx-mock.mp3').write_bytes(fx)
        text,st,en=timeline.flatten_alignment(al);tim=timeline.build_timeline(fixture['script'],text,st,en)
        # Test exact Thai words, not fabricated fallback timestamps.
        assert all(s['phrases'] and s['s']>=0 and s['e']<=8 for s in tim)
        cues=[{'sfx':'click','t':.08,'gain':.15},{'sfx':'click','t':4.08,'gain':.15}]
        mixed,stems=audio.mix(str(folder/'narration-mock.mp3'),8,{'click':str(folder/'sfx-mock.mp3')},cues,duck_sfx=True)
        mix=audio.finish(audio.write_wav(str(folder/'raw.wav'),mixed),str(folder/'mix.wav'))
        (folder/'subtitles.srt').write_text(timeline.srt(tim,8));(folder/'storyboard.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2))
        data,stats=run({'html':(Path(__file__).parent/'fixtures'/f'{kind}.html').read_text(),'duration':8,'width':1080,'height':1920,'fps':30},image=image,timeout=300,trusted_fixture=True)
        artifacts=validate_archive(data)
        for name,content in artifacts.items():(folder/('lemo-'+name)).write_bytes(content)
        lemo_subs=str(folder/'lemo-subtitled.mp4')
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(folder/'lemo-video.mp4'),'-vf',f"subtitles={folder/'subtitles.srt'}:force_style='Fontname=Noto Sans Thai,Fontsize=16,Outline=2,MarginV=26'",'-c:v','libx264','-threads','2','-preset','fast','-pix_fmt','yuv420p',lemo_subs],check=True)
        lemo=rendering.mux(lemo_subs,mix,str(folder/'lemo-final.mp4'))
        src=folder/'classic-source.py';src.write_text(classic_source(kind));start=time.monotonic()
        parts,frames,misses=rendering.render_all(str(src),tim,8,'MOCK PROVIDERS · DEVELOPMENT',str(folder/'classic-scenes'),1)
        classic=rendering.mux(rendering.concat(parts,str(folder/'classic-silent.mp4')),mix,str(folder/'classic-final.mp4'))
        classic_seconds=time.monotonic()-start
        rendering.first_frame(classic,str(folder/'classic-preview.png'))
        results={engine:qa.run(path,8,tim,stems,cues,{'click':.5},[],{'sources':fixture['sources'],'claims':[]},[]) for engine,path in [('classic',classic),('lemo',lemo)]}
        if not all(r['ok'] for r in results.values()):raise RuntimeError(json.dumps(results))
        item={'story':kind,'topic':fixture['topic'],'style':fixture['creative']['candidates'][['nik','dream','cats'].index(kind)]['id'],'classic_seconds':classic_seconds,'lemo_stats':stats,'qa':results,'voice_metadata':metadata,'sfx_metadata':fxmeta,'subtitle_sync':'mock alignment only; no real Thai voice verification'}
        report['stories'].append(item);(output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(kind,'Classic + Lemo MP4 QA passed (mock audio)',flush=True)
    print(str(output/'report.json'),flush=True)


if __name__=='__main__':main()
