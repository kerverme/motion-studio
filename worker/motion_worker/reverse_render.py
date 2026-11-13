"""Typed Motion graphics and local composition; never executes generated code."""
import json
import math
import subprocess
import re
from fractions import Fraction
from pathlib import Path
from PIL import Image,ImageDraw
from engine.core import F as font
from .reverse_media import probe


def ffmpeg(args):
    subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-threads','2',*map(str,args)],check=True,capture_output=True,timeout=1200)


def frame(graphic,t,width,height,transparent=False):
    image=Image.new('RGBA',(width,height),(0,0,0,0) if transparent else graphic['background'])
    for layer in graphic['layers']:
        if not layer['enter']<=t<=layer['exit']:continue
        progress=min(1,(t-layer['enter'])/max(.05,min(.2,layer['exit']-layer['enter'])))
        alpha=int(255*progress) if layer['motion']=='fade' else 255
        x,y=layer['x']*width,layer['y']*height;w,h=layer['width']*width,layer['height']*height
        if layer['motion']=='slide_left':x+=(1-progress)*width*.15
        if layer['motion']=='slide_up':y+=(1-progress)*height*.1
        if layer['motion']=='grow':w*=progress;h*=progress
        canvas=Image.new('RGBA',image.size,(0,0,0,0));draw=ImageDraw.Draw(canvas)
        color=tuple(bytes.fromhex(layer['color'][1:]))+(alpha,)
        kind=layer['kind']
        if kind in ('text','counter'):
            text=layer['text'] if kind=='text' else str(round(layer['from']+(layer['to']-layer['from'])*t))
            # Same Thai-capable Kanit fonts as the existing Motion engine.
            draw.multiline_text((x,y),text,font=font(round(layer['size']*width/1080),700),fill=color,spacing=8)
        elif kind=='circle':draw.ellipse((x,y,x+w,y+h),fill=color)
        elif kind=='line':draw.line((x,y,x+w,y+h),fill=color,width=max(1,round(layer['size']*width/1080)))
        elif kind=='bar':draw.rectangle((x,y,x+w*max(0,min(1,layer['from']+(layer['to']-layer['from'])*t)),y+h),fill=color)
        else:draw.rectangle((x,y,x+w,y+h),fill=color)
        image=Image.alpha_composite(image,canvas)
    return image


def code_motion(graphic,path,duration,width,height,fps=30,*,transparent=False,cues=None):
    count=max(1,round(duration*fps));codec=['-c:v','qtrle','-pix_fmt','argb'] if transparent else ['-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p']
    proc=subprocess.Popen(['ffmpeg','-v','error','-nostdin','-y','-f','rawvideo','-pix_fmt','rgba','-s',f'{width}x{height}',
        '-r',str(fps),'-i','pipe:0','-an',*codec,str(path)],stdin=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for i in range(count):
            img=frame(graphic,i/max(1,count-1),width,height,transparent)
            for cue in cues or []:
                if cue['start']<=i/fps<cue['end']:
                    draw=ImageDraw.Draw(img);f=font(max(12,round(width*.045)),700);text=cue['text'];box=draw.textbbox((0,0),text,font=f)
                    x=(width-box[2])/2;y=height*.85
                    draw.rectangle((x-12,y-6,x+box[2]+12,y+box[3]+6),fill=(0,0,0,210))
                    draw.text((x,y),text,font=f,fill='white',stroke_width=1,stroke_fill='black')
            proc.stdin.write(img.tobytes())
        proc.stdin.close();error=proc.stderr.read();code=proc.wait(timeout=120)
        if code:raise RuntimeError('Typed Motion render failed: '+error.decode()[-300:])
    except Exception:
        proc.kill();proc.wait();raise
    return path


def normalize(raw,path,duration,width,height,fps=30):
    info=probe(raw);actual=float(info['format']['duration'])
    if actual+1/fps<duration:raise ValueError('Generated shot is too short; inspect before approving a repair')
    ffmpeg(['-i',raw,'-an','-vf',f'scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1,fps={fps}',
        '-frames:v',max(1,round(duration*fps)),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',path])
    return path


def subtitles(alignment,task,duration):
    chars=alignment['characters'];starts=alignment['character_start_times_seconds'];ends=alignment['character_end_times_seconds']
    if not(len(chars)==len(starts)==len(ends)) or ''.join(chars)!=task['text']:raise ValueError('Subtitle alignment is not the approved speech')
    cues=[];offset=task['start_s'];text='';begin=None
    for char,start,end in zip(chars,starts,ends):
        if not 0<=start<=end or offset+end>duration+.05:raise ValueError('Subtitle time exceeds the measured shot')
        begin=offset+start if begin is None else begin;text+=char
        if len(text)>=28 or char in '.!?。\n':
            cues.append({'start':begin,'end':offset+end,'text':text});text='';begin=None
    if text:cues.append({'start':begin,'end':offset+ends[-1],'text':text})
    return cues


def compose(video,path,duration,audio_tasks,*,overlay=None,cues=None):
    args=['-i',video];filters=[];v='0:v';n=1
    if overlay:
        args+=['-i',overlay];filters.append('[0:v][1:v]overlay=0:0[v0]');v='v0';n+=1
    labels=[]
    for task in audio_tasks:
        args+=['-i',task['path']];label='a'+str(n);delay=round(task['start_s']*1000)
        filters.append(f'[{n}:a]atrim=0:{task["duration_s"]},asetpts=PTS-STARTPTS,adelay={delay}:all=1,volume={task["gain"]}[{label}]');labels.append('['+label+']');n+=1
    if labels:filters.append(''.join(labels)+f'amix=inputs={len(labels)}:normalize=0,alimiter=limit=0.95,apad,atrim=0:{duration}[mix]')
    else:
        args+=['-f','lavfi','-i','anullsrc=r=48000:cl=stereo'];filters.append(f'[{n}:a]atrim=0:{duration}[mix]')
    # Subtitle text goes in generated PNGs rather than an FFmpeg expression.
    # User/model strings are never interpolated into executable filter syntax.
    if cues:
        raise ValueError('Subtitle overlay must be rendered from alignment before compose')
    if filters:args+=['-filter_complex',';'.join(filters)]
    args+=['-map','['+v+']' if v!='0:v' else '0:v','-map','[mix]','-t',duration,'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-ar','48000',path]
    ffmpeg(args);return path


def technical_qa(path,expected,width,height,fps=30,*,audio_expected=False):
    info=probe(path);video=next(s for s in info['streams'] if s['codec_type']=='video');duration=float(info['format']['duration'])
    errors=[]
    if abs(duration-expected)>max(1/fps+.025,.06):errors.append('duration_mismatch')
    if(video['width'],video['height'])!=(width,height):errors.append('resolution_mismatch')
    if abs(float(Fraction(video['avg_frame_rate']))-fps)>.01:errors.append('fps_mismatch')
    decoded=subprocess.run(['ffmpeg','-v','error','-nostdin','-i',str(path),'-f','null','-'],capture_output=True,timeout=300)
    if decoded.returncode or decoded.stderr.strip():errors.append('decode_errors')
    checks=subprocess.run(['ffmpeg','-hide_banner','-nostdin','-i',str(path),'-vf','blackdetect=d=0.25:pix_th=0.02',
        '-af','astats=metadata=0:reset=0,ebur128=peak=true','-f','null','-'],capture_output=True,text=True,timeout=300)
    # Black frames can be intentional; report them for review, not fabricated failure.
    lines=[l.strip() for l in checks.stderr.splitlines() if any(k in l for k in ['black_start:','Peak level dB:','I:','Peak:'])]
    audio=any(s['codec_type']=='audio' for s in info['streams'])
    def last(pattern):
        values=re.findall(pattern,checks.stderr)
        if not values:return None
        return float(values[-1])
    true_peak=last(r'\n\s*Peak:\s+(-?\d+(?:\.\d+)?|-inf)\s+dBFS')
    loudness=last(r'\n\s*I:\s+(-?\d+(?:\.\d+)?|-inf)\s+LUFS')
    warnings=[]
    if true_peak is not None and true_peak>.1:errors.append('audio_clipping')
    if audio_expected and (not audio or true_peak is None or true_peak==float('-inf')):errors.append('planned_audio_missing_or_silent')
    if any('black_start:' in line for line in lines):warnings.append('black_interval_needs_review')
    if loudness is not None and loudness<-30 and audio_expected:warnings.append('quiet_audio_needs_review')
    def finite(value):return value if value is not None and math.isfinite(value) else None
    return {'schema':'motion.reverse.qa.v1','ok':not errors,'errors':errors,'duration_s':duration,'expected_s':expected,
            'width':video['width'],'height':video['height'],'fps':video['avg_frame_rate'],'codec':video['codec_name'],'audio_present':audio,
            'audio_blackframe_measurements':lines[-40:],'integrated_loudness_lufs':finite(loudness),'true_peak_dbfs':finite(true_peak),'audio_expected':audio_expected,'warnings':warnings,
            'visual_review':'not_run','uncertainty':['Technical decode cannot establish visual or identity correctness.']}


def assemble(paths,output,workspace):
    listing=Path(workspace)/'concat-generated-only.txt'
    # Paths are generated numeric filenames inside the private job workspace.
    listing.write_text(''.join("file '"+str(Path(p).resolve()).replace("'","'\\''")+"'\n" for p in paths))
    ffmpeg(['-f','concat','-safe','0','-i',listing,'-c:v','copy','-c:a','aac','-movflags','+faststart',output]);return output
