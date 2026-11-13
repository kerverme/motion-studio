"""Separate approved ElevenLabs assets; no synthetic subtitle timing."""
import datetime as dt
import json
import os
from pathlib import Path
import requests
from . import eleven,audio,config
from .creative_ledger import cached_call,digest
from .reverse_media import save_private
from .reverse_provider import fingerprint
from .text_video import ApprovalRequired,check_active


def produce_audio(ctx,project,task,quote):
    a=task['payload'];check_active(ctx)
    if quote['key_fingerprints'].get('eleven')!=fingerprint('ELEVENLABS_API_KEY'):raise ApprovalRequired('ElevenLabs key changed since approval')
    if dt.datetime.now(dt.timezone.utc)>dt.datetime.fromisoformat(quote['valid_until']):raise ApprovalRequired('Audio approval expired')
    if os.environ.get('MOTION_FAKE_ELEVEN')=='1':raise ApprovalRequired('Fake audio is forbidden in actual reverse-production jobs')
    payload={'project_id':str(project['id']),'task':a,'contract':'motion.reverse.audio.v1'}
    def generate(_reservation):
        check_active(ctx)
        if a['role'] in ('narration','dialogue'):
            # Read-only provider availability/voice checks happen before paid POST.
            r=requests.get(config.ELEVENLABS_BASE+'/v1/models',headers={'xi-api-key':config.ELEVENLABS_API_KEY},timeout=25);r.raise_for_status()
            if a['model'] not in [x.get('model_id') for x in r.json()]:raise ApprovalRequired('Selected preferred speech model is not currently available')
            r=requests.get(config.ELEVENLABS_BASE+'/v1/voices/'+a['voice_id'],headers={'xi-api-key':config.ELEVENLABS_API_KEY},timeout=25);r.raise_for_status()
            data,alignment,meta=eleven.tts_with_timestamps(a['text'],a['voice_id'],a['model'])
        elif a['role']=='sfx':
            data,meta=eleven.sound_effect(a['text'],a['duration_s'],model_id=a['model']);alignment=None
        else:
            data,meta=eleven.music(a['text'],round(a['duration_s']*1000),a['model']);alignment=None
        path=ctx.path('audio',digest(payload)+'.mp3');Path(path).write_bytes(data)
        length=audio.duration(path)
        asset=save_private(ctx,project['id'],path,'generated_'+a['role'],shot_id=task['shot_id'],content_type='audio/mpeg',metadata={'task':a,'duration_s':length,'quote_id':quote['id']})
        alignment_asset=None;keys=[asset['storage_key']]
        if alignment:
            alpath=ctx.path('audio',digest(payload)+'.json');Path(alpath).write_text(json.dumps(alignment,ensure_ascii=False))
            alignment_asset=save_private(ctx,project['id'],alpath,'generated_alignment',shot_id=task['shot_id'],content_type='application/json',metadata={'audio_asset_id':str(asset['id'])});keys.append(alignment_asset['storage_key'])
        return {'asset_id':str(asset['id']),'alignment_asset_id':str(alignment_asset['id']) if alignment_asset else None,'duration_s':length,'fits_approved_slot':length<=a['duration_s']+.05,'task':a,'asset_keys':keys,'usage':meta,'provider_id':meta.get('request_id')}
    return cached_call(ctx,task['category'],a['model'],payload,task['usd'],generate)
