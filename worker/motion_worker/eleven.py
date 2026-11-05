"""ElevenLabs REST client used directly from the Railway worker (no signed media URLs involved)."""
import base64, hashlib, json, time
import requests
from . import config


class ElevenError(RuntimeError):
    pass


def _headers():
    if not config.ELEVENLABS_API_KEY:
        raise ElevenError('ELEVENLABS_API_KEY is not set on motion-worker')
    return {'xi-api-key': config.ELEVENLABS_API_KEY, 'content-type': 'application/json'}


def _post(path, body, params=None, expect_json=True, timeout=300):
    url = config.ELEVENLABS_BASE + path
    for attempt in range(4):
        r = requests.post(url, headers=_headers(), json=body, params=params or {}, timeout=timeout)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
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


def tts_with_timestamps(text, voice_id, model_id='eleven_v4', language_code='th', stability=0.4, similarity_boost=0.75,
                        previous_text=None, next_text=None, speed=None):
    body = {'text': text, 'model_id': model_id, 'language_code': language_code,
            'voice_settings': {'stability': stability, 'similarity_boost': similarity_boost}}
    if speed and abs(float(speed) - 1.0) > 0.01:   # owner's rule: a brisk voice (ElevenLabs accepts 0.7-1.2)
        body['voice_settings']['speed'] = max(0.7, min(1.2, float(speed)))
    if previous_text:
        body['previous_text'] = previous_text
    if next_text:
        body['next_text'] = next_text
    try:
        try:
            data, meta = _post(f'/v1/text-to-speech/{voice_id}/with-timestamps', body, {'output_format': 'mp3_44100_128'})
        except ElevenError as e:
            if 'speed' in body['voice_settings'] and 'speed' in str(e).lower():   # this model refuses "speed": keep the default pace rather than fail
                del body['voice_settings']['speed']
                data, meta = _post(f'/v1/text-to-speech/{voice_id}/with-timestamps', body, {'output_format': 'mp3_44100_128'})
                meta['speed_ignored'] = True
            else:
                raise
    except ElevenError as e:
        # some models reject language_code / settings combinations; retry with the documented Thai-capable v3 model
        if model_id != 'eleven_v3' and ('model' in str(e).lower() or '422' in str(e) or '400' in str(e)):
            body['model_id'] = 'eleven_v3'
            data, meta = _post(f'/v1/text-to-speech/{voice_id}/with-timestamps', body, {'output_format': 'mp3_44100_128'})
            meta['model_fallback'] = 'eleven_v3'
        else:
            raise
    audio = base64.b64decode(data['audio_base64'])
    align = data.get('alignment') or data.get('normalized_alignment')
    if not audio or not align:
        raise ElevenError('TTS response missing audio or alignment')
    meta['model_id'] = body['model_id']
    return audio, align, meta


def sound_effect(prompt, duration, prompt_influence=0.5):
    body = {'text': prompt, 'duration_seconds': duration, 'prompt_influence': prompt_influence, 'model_id': 'eleven_text_to_sound_v2'}
    audio, meta = _post('/v1/sound-generation', body, {'output_format': 'mp3_44100_128'}, expect_json=False)
    return audio, meta


def music(prompt, length_ms, model_id='music_v1'):
    body = {'prompt': prompt, 'music_length_ms': int(max(3000, min(600000, length_ms))), 'model_id': model_id, 'force_instrumental': True}
    audio, meta = _post('/v1/music', body, {'output_format': 'mp3_44100_128'}, expect_json=False, timeout=600)
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
