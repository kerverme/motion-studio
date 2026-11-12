"""ElevenLabs REST client used directly from the Railway worker (no signed media URLs involved)."""
import base64, hashlib, json, math, time
import requests
from . import config


class ElevenError(RuntimeError):
    pass


def _headers():
    if not config.ELEVENLABS_API_KEY:
        raise ElevenError('ELEVENLABS_API_KEY is not set on motion-worker')
    return {'xi-api-key': config.ELEVENLABS_API_KEY, 'content-type': 'application/json'}


def _post(path, body, params=None, expect_json=True, timeout=300, attempts=4):
    url = config.ELEVENLABS_BASE + path
    for attempt in range(attempts):
        r = requests.post(url, headers=_headers(), json=body, params=params or {}, timeout=timeout)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
            time.sleep(2 ** attempt * 3)
            continue
        if r.status_code >= 400:
            try:
                detail = r.json()
            except Exception:
                detail = r.text[:400]
            raise ElevenError(f'{path} -> HTTP {r.status_code}: {json.dumps(detail)[:600]}')
        cost = r.headers.get('character-cost') or r.headers.get('x-character-count')
        meta = {'request_id': r.headers.get('request-id'), 'character_cost': float(cost) if cost else None}
        return (r.json() if expect_json else r.content), meta
    raise ElevenError(f'{path} failed after retries')


def cache_key(kind, payload):
    return kind + ':' + hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def validated_alignment(data, text):
    """Use real character times only. Never interpolate a missing Thai alignment."""
    import math, re
    compact = lambda value: re.sub(r'\s+', '', value)
    for name in ('normalized_alignment', 'alignment'):
        align = data.get(name)
        if not isinstance(align, dict):
            continue
        chars = align.get('characters', [])
        starts = align.get('character_start_times_seconds', [])
        ends = align.get('character_end_times_seconds', [])
        if not chars or len(chars) != len(starts) or len(chars) != len(ends):
            continue
        if not all(isinstance(c, str) for c in chars) or compact(''.join(chars)) != compact(text):
            continue
        if any(not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in starts + ends):
            continue
        if any(a > b for a, b in zip(starts, ends)) or any(a > b for a, b in zip(starts, starts[1:])) or any(a > b for a, b in zip(ends, ends[1:])):
            continue
        return align, name
    raise ElevenError('Missing or invalid narration alignment; accurate Thai timing is required')


def tts_with_timestamps(text, voice_id, model_id='eleven_v4', language_code='th', stability=0.4, similarity_boost=0.75,
                        previous_text=None, next_text=None, speed=None):
    if not voice_id:
        raise ElevenError('A configured voice_id is required')
    if model_id == 'eleven_v4':
        if len(text) > 2000:
            raise ElevenError('Split v4 dialogue into requests of at most 2000 characters')
        body = {'inputs': [{'text': text, 'voice_id': voice_id}], 'model_id': model_id,
                'language_code': language_code, 'settings': {'stability': stability, 'similarity': similarity_boost}}
        path = '/v1/text-to-dialogue/with-timestamps'
    else:
        body = {'text': text, 'model_id': model_id, 'language_code': language_code,
                'voice_settings': {'stability': stability, 'similarity_boost': similarity_boost}}
        if speed:
            body['voice_settings']['speed'] = max(.7, min(1.2, float(speed)))
        if previous_text:
            body['previous_text'] = previous_text
        if next_text:
            body['next_text'] = next_text
        path = f'/v1/text-to-speech/{voice_id}/with-timestamps'
    # POST has no guaranteed provider idempotency. The caller reserves before it;
    # a timeout/5xx is ambiguous and must not trigger another paid model/request.
    data, meta = _post(path, body, {'output_format': 'mp3_44100_128'}, attempts=1)
    audio = base64.b64decode(data.get('audio_base64', ''), validate=True)
    align, origin = validated_alignment(data, text)
    if not audio:
        raise ElevenError('Narration audio missing')
    if model_id == 'eleven_v4':
        segments = data.get('voice_segments')
        if not isinstance(segments, list) or not segments:
            raise ElevenError('v4 response missing voice_segments')
        for segment in segments:
            a, b = segment.get('start_time_seconds'), segment.get('end_time_seconds')
            lo, hi = segment.get('character_start_index'), segment.get('character_end_index')
            if segment.get('voice_id') != voice_id or segment.get('dialogue_input_index') != 0 or not all(isinstance(t, (int,float)) and math.isfinite(t) for t in (a,b)) or not 0 <= a <= b or not isinstance(lo,int) or not isinstance(hi,int) or not 0 <= lo <= hi <= len(align['characters']):
                raise ElevenError('Invalid v4 voice segment timing or speaker identity')
    meta.update(model_id=model_id, alignment_source=origin, voice_segments=data.get('voice_segments', []),
                speed_ignored=model_id == 'eleven_v4' and bool(speed and speed != 1))
    return audio, align, meta


def sound_effect(prompt, duration, prompt_influence=0.5, model_id='eleven_text_to_sound_v2', loop=False):
    if model_id not in ('eleven_text_to_sound_v3', 'eleven_text_to_sound_v2'):
        raise ElevenError('Unsupported SFX model')
    if loop and model_id != 'eleven_text_to_sound_v2':
        raise ElevenError('SFX v3 does not support loop')
    if not .5 <= float(duration) <= 30:
        raise ElevenError('SFX duration must be 0.5–30 seconds')
    body = {'text': prompt, 'duration_seconds': duration, 'prompt_influence': prompt_influence, 'model_id': model_id, 'loop': loop}
    audio, meta = _post('/v1/sound-generation', body, {'output_format': 'mp3_44100_128'}, expect_json=False, attempts=1)
    if not audio:
        raise ElevenError('SFX response missing audio')
    meta.update(model_id=model_id, prompt=prompt, duration=duration)
    return audio, meta


def music(prompt, length_ms, model_id='music_v1'):
    body = {'prompt': prompt, 'music_length_ms': int(max(3000, min(600000, length_ms))), 'model_id': model_id, 'force_instrumental': True}
    audio, meta = _post('/v1/music', body, {'output_format': 'mp3_44100_128'}, expect_json=False, timeout=600, attempts=1)
    return audio, meta


# ---------------------------------------------------------------- development fake (MOTION_FAKE_ELEVEN=1); never used in production
if __import__('os').environ.get('MOTION_FAKE_ELEVEN') == '1':
    import subprocess as _sp

    def _tone(seconds, freq=220):
        return _sp.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={seconds:.3f}',
                        '-af', 'volume=0.4,tremolo=f=6:d=0.8', '-b:a', '128k', '-f', 'mp3', '-'], capture_output=True, check=True).stdout

    def tts_with_timestamps(text, voice_id, model_id='fake', language_code='th', stability=0.4, similarity_boost=0.75, previous_text=None, next_text=None, speed=None):
        per = 0.075 / (speed or 1.0)
        chars = list(text)
        st = [0.2 + i * per for i in range(len(chars))]
        en = [s + per for s in st]
        return _tone(0.2 + len(chars) * per + 0.3), {'characters': chars, 'character_start_times_seconds': st, 'character_end_times_seconds': en}, {'model_id': 'fake', 'character_cost': len(text)}

    def sound_effect(prompt, duration, prompt_influence=0.5):
        return _tone(duration, 880), {'character_cost': None}

    def music(prompt, length_ms, model_id='music_v1'):
        return _tone(length_ms / 1000, 330), {'character_cost': None}
