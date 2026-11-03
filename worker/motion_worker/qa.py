"""Automated QA on the finished episode. Returns a report; `ok` is False when any hard check fails."""
import re, subprocess
import numpy as np
from . import audio


def blackdetect(path):
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', path, '-vf', 'blackdetect=d=0.3:pix_th=0.08', '-an', '-f', 'null', '-'],
                       capture_output=True, text=True)
    return [dict(zip(('start', 'end', 'duration'), map(float, m))) for m in
            re.findall(r'black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)', r.stderr)]


def frame_stats(path, times):
    out = []
    for t in times:
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.2f}', '-i', path, '-frames:v', '1', '-vf', 'scale=270:480',
                              '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
        a = np.frombuffer(raw, np.uint8)
        out.append({'t': round(t, 2), 'std': float(a.std()) if a.size else 0.0, 'decoded': bool(a.size)})
    return out


def run(final_mp4, end_s, timeline, stems, cues, sfx_durations, missing_words, package, sfx_misses):
    checks, warnings = [], []

    def check(name, ok, detail=None, hard=True):
        checks.append({'name': name, 'ok': bool(ok), 'hard': hard, 'detail': detail})

    info = audio.ffprobe(final_mp4)
    v = [s for s in info['streams'] if s['codec_type'] == 'video']
    a = [s for s in info['streams'] if s['codec_type'] == 'audio']
    check('decodes', bool(v and a), {'streams': len(info['streams'])})
    if v:
        vs = v[0]
        fps = eval(vs.get('r_frame_rate', '0/1'))
        check('video_spec', vs['codec_name'] == 'h264' and vs['width'] == 1080 and vs['height'] == 1920 and abs(fps - 30) < 0.01,
              {'codec': vs['codec_name'], 'size': f"{vs['width']}x{vs['height']}", 'fps': fps})
    if a:
        check('audio_spec', a[0]['codec_name'] == 'aac', {'codec': a[0]['codec_name'], 'sr': a[0].get('sample_rate')})
    dur = float(info['format']['duration'])
    check('duration', abs(dur - end_s) < 0.25, {'file': round(dur, 2), 'timeline': round(end_s, 2)})

    final = audio.decode(final_mp4)
    peak_db = audio.db(np.abs(final).max())
    check('no_clipping', peak_db <= -0.5, {'peak_dbfs': round(peak_db, 2)})
    vo = stems['vo']
    vo_db = audio.db(np.sqrt(np.mean(vo.astype(np.float64) ** 2)))
    check('narration_present', vo_db > -45, {'vo_rms_dbfs': round(vo_db, 1)})
    # sync: narration audio onset must match the first word in the timeline
    env = audio.envelope(vo, 0.02)
    onset = float(np.argmax(env > 0.02) / audio.SR) if (env > 0.02).any() else -1
    first = timeline[0]['phrases'][0]['words'][0]['s']
    check('av_sync', abs(onset - first) < 0.35, {'audio_onset': round(onset, 2), 'first_word': first})

    # SFX must not bury narration
    loud = []
    for c in cues:
        d = sfx_durations.get(c['sfx'], 1.0)
        s_db = audio.window_db(stems['sfx'], c['t'], c['t'] + min(d, 2.0))
        v_db = audio.window_db(stems['vo'], c['t'], c['t'] + min(d, 2.0))
        if v_db > -40 and s_db - v_db > 1.0:
            loud.append({**c, 'sfx_db': round(s_db, 1), 'vo_db': round(v_db, 1)})
    check('sfx_under_narration', not loud, loud[:10])

    bl = blackdetect(final_mp4)
    check('no_black_frames', not bl, bl[:5])
    mids = [(s['s'] + s['e']) / 2 for s in timeline]
    fs = frame_stats(final_mp4, mids)
    check('scenes_render_content', all(f['decoded'] and f['std'] > 6 for f in fs), fs)

    check('animation_cues_resolved', len(missing_words) <= 3, missing_words[:10], hard=False)
    check('sfx_cues_resolved', not sfx_misses, sfx_misses[:10], hard=False)
    facts = [c for c in package.get('claims', []) if c.get('kind', 'fact') == 'fact']
    bad = [c['text'] for c in facts if not c.get('source_ids')]
    check('claims_sourced', not bad, bad, hard=True)
    check('sources_listed', len(package.get('sources', [])) > 0 or not facts, None, hard=True)

    ok = all(c['ok'] for c in checks if c['hard'])
    return {'ok': ok, 'checks': checks, 'loud_cues': loud}
