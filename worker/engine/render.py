"""Frame composition and scene rendering. Episode code supplies SCENES = {segment_id: (fn, (top_rgb, bottom_rgb))}."""
import importlib.util, os, subprocess, sys, types
from . import core, styles
from .core import W, H, FPS, gradient, eio, series_tag, subtitles
from PIL import Image, ImageDraw

STYLE = 'classic'   # visual style of the episode being rendered (engine.styles)


def load_episode_module(path, timeline, end=None, series_tag_text=None, style='classic'):
    global STYLE
    STYLE = style if style in styles.STYLES else 'classic'
    _LAST.clear()
    core.load_timeline(timeline, end, series_tag_text)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if root not in sys.path:
        sys.path.insert(0, root)
    spec = importlib.util.spec_from_file_location('episode_scenes', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, 'SCENES'):
        raise RuntimeError('episode scene code must define SCENES')
    missing = [sid for sid in core.ORDER if sid not in mod.SCENES]
    if missing:
        raise RuntimeError(f'SCENES has no renderer for segments: {missing}')
    return mod


def scene_frame(mod, sid, t):
    """One scene's full picture (world + UI) in the episode's style."""
    if STYLE == 'classic':
        fn, (top, bot) = mod.SCENES[sid]
        img = gradient(top, bot)
        d = ImageDraw.Draw(img, 'RGBA')
        fn(img, d, t)
        return img
    world, chars, ui = _layers(mod, sid, t)
    out = styles.apply(STYLE, world, chars, t)
    out.alpha_composite(ui)
    return out


def _layers(mod, sid, t):
    from . import templates
    fn, (top, bot) = mod.SCENES[sid]
    img = gradient(top, bot)
    chars = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ui = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    templates.UI.update(base=img, layer=ui, chars=chars)
    try:
        fn(img, ImageDraw.Draw(img, 'RGBA'), t)
    finally:
        templates.UI.update(base=None, layer=None, chars=None)
    return img, chars, ui


_LAST = {}


def _styled(mod, k, t, transition):
    """World + UI for scene k at time t, styled. Stop-motion styles hold each drawing for several frames, so the last result is reused."""
    th = styles.hold_time(STYLE, t)
    trans = k > 0 and th < core.STARTS[k] + transition
    key = (k, th, trans)
    if _LAST.get('key') == key:
        return _LAST['img'].copy()
    world, chars, ui = _layers(mod, core.ORDER[k], th)
    if trans:
        pw, pc, pu = _layers(mod, core.ORDER[k - 1], th)
        u = eio((th - core.STARTS[k]) / transition)
        mask = Image.new('L', (W, H), 0)
        R = 1150 * u
        ImageDraw.Draw(mask).ellipse((540 - R, 900 - R, 540 + R, 900 + R), fill=255)
        world = Image.composite(world, pw, mask)
        chars = Image.composite(chars, pc, mask)
        ui = Image.composite(ui, pu, mask)
    img = styles.apply(STYLE, world, chars, th)
    img.alpha_composite(ui)
    _LAST.update(key=key, img=img)
    return img.copy()


def frame(mod, t, transition=0.3):
    k = max(i for i, s in enumerate(core.STARTS) if t >= s)
    sid = core.ORDER[k]
    if STYLE != 'classic':
        img = _styled(mod, k, t, transition)
    else:
        img = scene_frame(mod, sid, t)
        if k > 0 and t < core.STARTS[k] + transition:
            prev = scene_frame(mod, core.ORDER[k - 1], t)
            u = eio((t - core.STARTS[k]) / transition)
            mask = Image.new('L', (W, H), 0)
            md = ImageDraw.Draw(mask)
            R = 1150 * u
            md.ellipse((540 - R, 900 - R, 540 + R, 900 + R), fill=255)
            img = Image.composite(img, prev, mask)
    d = ImageDraw.Draw(img, 'RGBA')
    series_tag(img, d)
    subtitles(img, t)
    d.rectangle((0, H - 10, W * t / core.END, H), fill=(255, 225, 60, 255))
    return img.convert('RGB')


def scene_bounds(k):
    s = core.STARTS[k]
    e = core.STARTS[k + 1] if k + 1 < len(core.STARTS) else core.END
    return int(round(s * FPS)), int(round(e * FPS))


def render_scene(mod, k, out_path, crf=20):
    f0, f1 = scene_bounds(k)
    tmp = out_path[:-4] + '.part.mp4'
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-c:v', 'libx264', '-crf', str(crf), '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', str(FPS), tmp],
                         stdin=subprocess.PIPE)
    try:
        for fi in range(f0, f1):
            p.stdin.write(frame(mod, fi / FPS).tobytes())
    finally:
        p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f'ffmpeg failed for scene {k}')
    os.replace(tmp, out_path)
    return f1 - f0
