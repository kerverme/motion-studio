"""Audio decoding, sample-accurate mixing (narration + SFX + ducked music), stems for QA, and loudness finishing."""
import json, subprocess
import numpy as np

SR = 44100


def ffprobe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def duration(path):
    return float(ffprobe(path)['format']['duration'])


def decode(path, sr=SR):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(sr), '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def write_wav(path, x, sr=SR):
    x = np.clip(x, -1, 1)
    p = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ac', '2', '-ar', str(sr), '-i', '-', '-c:a', 'pcm_s16le', path],
                       input=x.astype(np.float32).tobytes(), check=True)
    return path


def envelope(x, win=0.05, sr=SR):
    m = np.abs(x).max(axis=1)
    n = max(1, int(win * sr))
    k = np.ones(n) / n
    return np.convolve(m, k, mode='same')


def db(v):
    return 20 * np.log10(max(float(v), 1e-9))


def mix(vo_path, end_s, sfx_files, cues, music_path=None, music_volume=0.3, duck_depth=0.6, fade_out=2.5):
    """Returns (mix, stems) as float32 stereo arrays of exactly end_s seconds."""
    N = int(round(end_s * SR))
    vo = np.zeros((N, 2), np.float32)
    v = decode(vo_path)[:N]
    vo[:len(v)] = v
    sfx = np.zeros((N, 2), np.float32)
    cache = {}
    for c in cues:
        if c['sfx'] not in cache:
            cache[c['sfx']] = decode(sfx_files[c['sfx']])
        s = cache[c['sfx']] * float(c['gain'])
        i = int(round(c['t'] * SR))
        j = min(N, i + len(s))
        if i < N:
            sfx[i:j] += s[:j - i]
    mus = np.zeros((N, 2), np.float32)
    if music_path:
        m = decode(music_path)
        if len(m) < N:  # loop with a short crossfade if the track is short
            reps = int(np.ceil(N / max(1, len(m)))) + 1
            m = np.concatenate([m] * reps)
        m = m[:N] * music_volume
        env = envelope(vo, 0.08)
        speech = np.clip(env / 0.05, 0, 1) ** 0.7
        # smooth the gain so ducking breathes instead of pumping
        k = int(0.25 * SR)
        g = 1 - duck_depth * np.convolve(speech, np.ones(k) / k, mode='same')
        m *= g[:, None].astype(np.float32)
        fo = int(fade_out * SR)
        m[-fo:] *= np.linspace(1, 0, fo, dtype=np.float32)[:, None]
        fi = int(0.4 * SR)
        m[:fi] *= np.linspace(0, 1, fi, dtype=np.float32)[:, None]
        mus = m
    out = vo + sfx + mus
    peak = np.abs(out).max()
    if peak > 0.89:
        out *= 0.89 / peak
    return out, {'vo': vo, 'sfx': sfx, 'music': mus}


def finish(mix_wav, out_m4a_input_wav, target_lufs=-14):
    """Loudness-normalise to target with a true-peak ceiling."""
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', mix_wav, '-af', f'loudnorm=I={target_lufs}:TP=-1.5:LRA=11,aresample=44100',
                    '-c:a', 'pcm_s16le', out_m4a_input_wav], check=True)
    return out_m4a_input_wav


def window_db(x, t0, t1, sr=SR):
    a, b = int(t0 * sr), int(t1 * sr)
    seg = x[a:b]
    if len(seg) == 0:
        return -120.0
    return db(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
