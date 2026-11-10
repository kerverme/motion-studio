"""Bounded temporal artwork diagnostics, not a semantic animation pass/fail.

The caller supplies raw scene layers so subtitles, channel badges, progress bars,
style grain and scene transitions cannot make an otherwise still scene look active.
Named cast motion is reported separately; character acting may itself be meaningful.
"""
import base64
import io
import math
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

CONTENT_CROP = (0, 330, 1080, 1380)
ANALYSIS_SIZE = (320, 311)
MAX_SAMPLES = 16
PIXEL_DELTA = 8
HELD_FRACTION = 0.003
STRIP_FRACTIONS = (0.05, 0.35, 0.65, 0.95)


def sample_times(duration, limit=MAX_SAMPLES):
    duration = max(0.01, float(duration))
    count = min(max(4, int(math.ceil(duration)) + 1), max(4, int(limit)))
    # Keep the final sample inside this scene, including its normal short tail.
    end = max(0.0, duration - 0.01)
    return [end * i / (count - 1) for i in range(count)]


def _pixels(image):
    return np.asarray(image.convert('L').crop(CONTENT_CROP).resize(ANALYSIS_SIZE)
                      .filter(ImageFilter.GaussianBlur(1.0)), dtype=np.int16)


def _intervals(pairs):
    intervals = []
    for pair in pairs:
        if not pair['held']:
            continue
        if intervals and abs(intervals[-1]['end'] - pair['start']) < 0.002:
            intervals[-1]['end'] = pair['end']
            intervals[-1]['seconds'] = round(intervals[-1]['end'] - intervals[-1]['start'], 3)
        else:
            intervals.append({'start': pair['start'], 'end': pair['end'],
                              'seconds': round(pair['end'] - pair['start'], 3)})
    return intervals


def analyse_frames(frames, times):
    """Measure a supplied sequence; thresholds only describe low pixel activity."""
    if len(frames) != len(times):
        raise ValueError('motion frame/time counts differ')
    return _analyse_pixels([_pixels(frame) for frame in frames], times)


def _analyse_pixels(pixels, times):
    pairs = []
    for i in range(1, len(pixels)):
        diff = np.abs(pixels[i] - pixels[i - 1])
        fraction = float(np.mean(diff > PIXEL_DELTA))
        pairs.append({'start': round(float(times[i - 1]), 3), 'end': round(float(times[i]), 3),
                      'changed_fraction': round(fraction, 6), 'mean_delta': round(float(diff.mean()), 3),
                      'held': fraction < HELD_FRACTION})
    holds = _intervals(pairs)
    return {'pairs': pairs, 'held_intervals': holds,
            'longest_hold_seconds': max((hold['seconds'] for hold in holds), default=0.0),
            'max_changed_fraction': max((pair['changed_fraction'] for pair in pairs), default=0.0)}


def _filmstrip(frames, times, duration):
    if not frames:
        return None
    panel = (180, 320)
    strip = Image.new('RGB', (panel[0] * 4, panel[1] + 22), '#f4f4f4')
    draw = ImageDraw.Draw(strip)
    for column, fraction in enumerate(STRIP_FRACTIONS):
        index = min(range(len(times)), key=lambda i: abs(times[i] - duration * fraction))
        strip.paste(frames[index].convert('RGB').resize(panel), (column * panel[0], 22))
        draw.text((column * panel[0] + 5, 5), f't={times[index]:.2f}s', fill='#151515')
    out = io.BytesIO()
    strip.save(out, 'JPEG', quality=85)
    return base64.b64encode(out.getvalue()).decode()


def capture_motion(render, mod, seg, origin, end, deadline):
    """Sample once per second, bounded to sixteen frames and a shared time budget.

    Images use the unstyled world/cast/UI layers. The normal styled visual-review
    frames remain separate. Coordinate labels are local to this scene.
    """
    duration = max(0.01, end - origin)
    wanted = sample_times(duration)
    frames, pixels, pixels_without_cast, times = [], [], [], []
    started = time.monotonic()
    error = None
    for local in wanted:
        if time.monotonic() >= deadline:
            error = 'temporal sampling budget exhausted; remaining motion is unreviewed'
            break
        try:
            world, cast, ui = render._layers(mod, seg, origin + local)
            background = world.copy()
            background.alpha_composite(ui)
            composite = world.copy()
            composite.alpha_composite(cast)
            composite.alpha_composite(ui)
            # Keep only small analysis/filmstrip copies instead of full-resolution frames.
            pixels.append(_pixels(composite))
            pixels_without_cast.append(_pixels(background))
            frames.append(composite.resize((360, 640)))
            times.append(local)
        except Exception as exc:
            error = f'temporal render failed: {type(exc).__name__}: {exc}'
            break
    result = {'method': 'raw-scene-layer-differences', 'diagnostic_only': True,
              'complete': len(times) == len(wanted), 'samples': len(times),
              'sample_times': [round(t, 3) for t in times],
              'sample_step_seconds': round(wanted[1] - wanted[0], 3),
              'content_crop': list(CONTENT_CROP), 'pixel_delta': PIXEL_DELTA,
              'held_changed_fraction_below': HELD_FRACTION,
              'excludes': ['subtitles', 'series badge', 'progress footer', 'transitions', 'style effects'],
              'note': 'Pixel activity is not proof of meaningful animation. Mouth movement, jitter, camera motion or text reveals may produce activity. Low activity may also be an intentional comprehension pause. Inspect the primary action and filmstrip.',
              **_analyse_pixels(pixels, times),
              'without_cast': {**_analyse_pixels(pixels_without_cast, times),
                               'note': 'Excludes named c.person/c.cat render layers only. Primitive-drawn figures remain. Character acting can legitimately carry the scene; this is not a separate failure condition.'},
              'ms': int((time.monotonic() - started) * 1000)}
    if error:
        result['error'] = error
    return result, _filmstrip(frames, times, duration) if result['complete'] else None
