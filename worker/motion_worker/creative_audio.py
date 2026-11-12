"""Approved v4 narration and SFX v3, with durable per-request checkpoints."""
import json, shutil
from . import audio, eleven, rendering, timeline
from .creative_ledger import cached_call, digest


def stage_audio(ctx):
    p, creative = ctx.pkg, ctx.pkg['creative']
    voice = p['voice']
    chunks = [s['text'] for s in p['script']]
    total_chars = sum(len(c) for c in chunks)
    paths, flat, starts, ends, offset, manifest = [], '', [], [], 0.0, []
    for i, text in enumerate(chunks):
        payload = {'text': text, 'voice': voice, 'endpoint_contract': 'dialogue-v4-2026-11-12'}
        def generate(_reservation, text=text, payload=payload):
            data, alignment, meta = eleven.tts_with_timestamps(text, voice['voice_id'], voice['model_id'], voice.get('language_code', 'th'), voice.get('stability', .4), voice.get('similarity_boost', .75), speed=voice.get('speed'))
            key = digest(payload)
            mp3 = ctx.path('audio', key + '.mp3'); open(mp3, 'wb').write(data)
            duration = audio.duration(mp3)
            if max(alignment['character_end_times_seconds']) > duration + .15:
                raise RuntimeError('Provider timestamps exceed audio duration')
            ak = 'creative/audio/' + key + '.mp3'; jk = 'creative/audio/' + key + '.json'
            ctx.store.put_file(ak, mp3, 'audio/mpeg')
            ctx.store.put_bytes(jk, json.dumps(alignment).encode(), 'application/json')
            return {'audio_key': ak, 'alignment_key': jk, 'duration': duration, 'meta': meta, 'usage': meta, 'provider_id': meta.get('request_id'), 'asset_keys': [ak, jk]}
        result = cached_call(ctx, 'narration', voice['model_id'], payload, creative['allocations']['narration'] * len(text) / total_chars, generate)
        mp3 = ctx.fetch(result['audio_key'], ctx.path('audio', f'chunk{i}.mp3'))
        al = json.load(open(ctx.fetch(result['alignment_key'], ctx.path('audio', f'chunk{i}.json'))))
        chars, st, en = timeline.flatten_alignment(al, offset)
        if flat:
            flat += ' '; starts.append(st[0]); ends.append(st[0])
        flat += chars; starts += st; ends += en
        offset += audio.duration(mp3); paths.append(mp3); manifest.append(result)
    vo = ctx.path('audio', 'narration.mp3')
    if len(paths) == 1:
        shutil.copyfile(paths[0], vo)
    else:
        rendering.concat(paths, vo)
    alpath = ctx.path('audio', 'alignment.json')
    json.dump({'text': flat, 'start': starts, 'end': ends}, open(alpath, 'w'), ensure_ascii=False)
    sfx, fx_manifest = {}, []
    effects = p.get('sfx', [])
    total_seconds = sum(f['duration'] for f in effects)
    for fx in effects:
        model = fx.get('model_id', 'eleven_text_to_sound_v3')
        payload = {'prompt': fx['prompt'], 'duration': fx['duration'], 'model': model, 'loop': False, 'prompt_influence': .5}
        def generate(_reservation, payload=payload, model=model):
            data, meta = eleven.sound_effect(payload['prompt'], payload['duration'], model_id=model)
            path = ctx.path('audio', digest(payload) + '.mp3'); open(path, 'wb').write(data)
            duration = audio.duration(path)
            if duration > payload['duration'] + 1 or duration < .1:
                raise RuntimeError('Unexpected SFX duration')
            key = 'creative/sfx/' + digest(payload) + '.mp3'; ctx.store.put_file(key, path, 'audio/mpeg')
            return {'audio_key': key, 'duration': duration, 'meta': meta, 'usage': meta, 'provider_id': meta.get('request_id'), 'asset_keys': [key]}
        result = cached_call(ctx, 'sfx', model, payload, creative['allocations']['sfx'] * fx['duration'] / total_seconds, generate)
        sfx[fx['id']] = result['audio_key']; fx_manifest.append({**fx, **result})
    return {'narration_key': ctx.save('narration', vo), 'alignment_key': ctx.save('alignment', alpath), 'narration_duration': audio.duration(vo),
            'sfx': sfx, 'music_key': None, 'narration_manifest': manifest, 'sfx_manifest': fx_manifest}
