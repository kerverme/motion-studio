"""Exact decoded-frame timing, local shot clips and encrypted evidence assets."""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import subprocess
import uuid
from decimal import Decimal
from fractions import Fraction
from pathlib import Path


def file_sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''): h.update(part)
    return h.hexdigest()


def probe(path):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)],timeout=30))


def frame_timing(path):
    info = probe(path); video = next(s for s in info['streams'] if s['codec_type']=='video')
    frames = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_frames',
        '-show_entries','frame=best_effort_timestamp_time,pkt_duration_time,duration_time','-of','json',str(path)],timeout=180))['frames']
    if not frames or len(frames)>1000000: raise ValueError('Unsupported decoded frame count')
    origin = Decimal(frames[0]['best_effort_timestamp_time'])
    pts = [float(Decimal(f['best_effort_timestamp_time'])-origin) for f in frames]
    rate = Fraction(video.get('avg_frame_rate') or video['r_frame_rate'])
    if rate<=0: raise ValueError('Video frame rate is not measurable')
    last_duration = frames[-1].get('duration_time',frames[-1].get('pkt_duration_time'))
    end = pts[-1] + (float(last_duration) if last_duration and float(last_duration)>0 else float(1/rate))
    return {'pts':pts,'end_s':end,'fps_num':rate.numerator,'fps_den':rate.denominator,
            'width':video['width'],'height':video['height'],'video_start_s':float(origin),
            'container_start_s':float(info['format'].get('start_time') or 0),
            'container_duration_s':float(info['format']['duration']),
            'has_audio':any(s['codec_type']=='audio' for s in info['streams'])}


def normalized_analysis(breakdown,source):
    timing = frame_timing(source); shots=[]; boundaries=[]
    for i,raw in enumerate(breakdown['shots']):
        start,end=int(raw['start_frame']),int(raw['end_frame'])
        if not 0<=start<end<=len(timing['pts']): raise ValueError('Upstream shot range is outside decoded video')
        if start!=(boundaries[-1] if boundaries else 0): raise ValueError('Upstream analysis contains a timing gap')
        boundaries.append(end)
        t0=timing['pts'][start];t1=timing['pts'][end] if end<len(timing['pts']) else timing['end_s']
        shots.append({'id':raw['id'],'index':i+1,'start_s':t0,'end_s':t1,'duration_s':t1-t0,
            'start_frame':start,'end_frame_exclusive':end,'frame_count':end-start,
            'source_evidence':{'timing':'measured','timing_source':'ffprobe_decoded_frame_pts',
                'upstream_start_s':raw['start'],'upstream_end_s':raw['end'],
                'camera_estimate':raw.get('features',{}).get('camera'),'aspects':raw.get('aspects',{}),
                'transition_in':raw.get('transition_in'),'boundary_score':raw.get('boundary_score'),
                'production_method_estimate':raw.get('base')},
            'semantic':None,'semantic_status':'not_run','uncertainty':['Semantic Vision analysis has not run. Technical heuristics are estimates.']})
    if boundaries[-1]!=len(timing['pts']): raise ValueError('Analysis omits decoded source frames')
    return {'schema':'motion.reverse.analysis.v1','source_sha256':file_sha(source),
        'source':{k:v for k,v in timing.items() if k!='pts'},'shots':shots,'audio':breakdown.get('audio',{}),
        'upstream_schema':breakdown.get('schema'),'semantic_status':'not_run'}


def clip(source,shot,output):
    """No stream-copy seeking: preserve the measured frame interval exactly."""
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    duration=shot['duration_s'];stretch=min(8,max(1,math.ceil(8/duration)))
    filter_=(f"trim=start_frame={shot['start_frame']}:end_frame={shot['end_frame_exclusive']},"
             f"setpts=(PTS-STARTPTS)*{stretch},scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1")
    args=['ffmpeg','-v','error','-nostdin','-y','-i',str(source),'-map','0:v:0','-vf',filter_,
          '-an','-c:v','libx264','-crf','24','-preset','veryfast','-fps_mode','passthrough','-enc_time_base','-1',
          '-movflags','+faststart',str(output)]
    subprocess.run(args,capture_output=True,check=True,timeout=180)
    def count(path):
        d=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-select_streams','v:0',
             '-show_entries','stream=nb_read_frames','-of','json',str(path)]));return int(d['streams'][0]['nb_read_frames'])
    expected=shot['frame_count'];actual=count(output)
    if actual==expected-1:
        repaired=output.with_name(output.stem+'-editlist-repair.mp4')
        try:
            subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-ignore_editlist','1','-i',str(output),
                '-map','0:v:0','-an','-c:v','copy','-movflags','+faststart',str(repaired)],capture_output=True,check=True,timeout=60)
            if count(repaired)==expected: os.replace(repaired,output);actual=expected
        finally:repaired.unlink(missing_ok=True)
    if actual!=expected: raise ValueError('Clip does not contain the exact measured source frames')
    if output.stat().st_size>4*1024*1024: raise ValueError('Approved Vision clip exceeds the 4 MiB limit')
    info=probe(output);video=next(s for s in info['streams'] if s['codec_type']=='video')
    return {'duration_s':float(video.get('duration') or info['format']['duration']),'stretch':stretch,
            'sha256':file_sha(output),'frame_count':actual,'audio_included':False,
            'width':video['width'],'height':video['height'],'bytes':output.stat().st_size}


def _key():
    value=os.environ.get('MOTION_REVERSE_STORAGE_KEY','')
    if len(value)!=64: raise ValueError('Private reverse storage key is not configured')
    return bytes.fromhex(value)


def key_id():return hashlib.sha256(_key()).hexdigest()[:16]


def replicate_private(ctx,asset,workspace):
    from . import r2,config
    if not r2.enabled() or asset.get('metadata',{}).get('r2_encrypted_replica'):return
    path=Path(workspace)/('replica-'+str(asset['id'])+'.sealed')
    try:
        ctx.store.get_file(asset['storage_key'],str(path));r2._client().upload_file(str(path),config.R2_BUCKET,asset['storage_key'],ExtraArgs={'ContentType':'application/octet-stream'})
        ctx.db.q("UPDATE reverse_assets SET metadata=metadata||'{\"r2_encrypted_replica\":true}'::jsonb WHERE id=%s",(asset['id'],))
    finally:path.unlink(missing_ok=True)


def save_private(ctx,project_id,path,role,*,shot_id=None,content_type='application/octet-stream',metadata=None):
    from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
    path=Path(path);ident=str(uuid.uuid4());key=f'reverse-private/{project_id}/{ident}.sealed'
    iv=os.urandom(12);encryptor=Cipher(algorithms.AES(_key()),modes.GCM(iv)).encryptor()
    sealed=path.with_name(path.name+'.'+ident+'.sealed')
    try:
        with path.open('rb') as src,sealed.open('wb') as dst:
            for part in iter(lambda:src.read(1024*1024),b''):dst.write(encryptor.update(part))
            dst.write(encryptor.finalize())
        ctx.store.put_file(key,str(sealed),'application/octet-stream')
        # Existing R2 delivery is public. Store only authenticated ciphertext;
        # the owner route decrypts it. A signed plaintext public URL is unsafe.
        from . import r2,config
        if r2.enabled():
            client=r2._client();client.upload_file(str(sealed),config.R2_BUCKET,key,ExtraArgs={'ContentType':'application/octet-stream'})
    finally:sealed.unlink(missing_ok=True)
    encryption={'algorithm':'aes-256-gcm','iv':iv.hex(),'tag':encryptor.tag.hex(),'key_id':key_id()}
    from psycopg.types.json import Jsonb
    return ctx.db.one('''INSERT INTO reverse_assets(id,project_id,shot_id,role,storage_key,sha256,bytes,content_type,encryption,metadata)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
        (ident,project_id,shot_id,role,key,file_sha(path),path.stat().st_size,content_type,Jsonb(encryption),Jsonb({**(metadata or {}),'r2_encrypted_replica':r2.enabled()})))


def fetch_private(ctx,asset,path):
    from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    if asset['encryption']['key_id']!=key_id(): raise ValueError('Original encryption key is required to restore this asset')
    sealed=path.with_name(path.name+'.sealed')
    try:
        try:ctx.store.get_file(asset['storage_key'],str(sealed))
        except Exception:
            from . import r2,config
            if not asset.get('metadata',{}).get('r2_encrypted_replica'):raise
            r2._client().download_file(config.R2_BUCKET,asset['storage_key'],str(sealed))
        data=asset['encryption'];decryptor=Cipher(algorithms.AES(_key()),modes.GCM(bytes.fromhex(data['iv']),bytes.fromhex(data['tag']))).decryptor()
        with sealed.open('rb') as src,path.open('wb') as dst:
            for part in iter(lambda:src.read(1024*1024),b''):dst.write(decryptor.update(part))
            dst.write(decryptor.finalize())
        if file_sha(path)!=asset['sha256']:raise ValueError('Source/evidence checksum mismatch')
        return path
    except Exception:
        path.unlink(missing_ok=True);raise
    finally:sealed.unlink(missing_ok=True)
