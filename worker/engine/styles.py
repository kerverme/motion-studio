"""Code-drawn visual styles. A style is applied to the "world" layer of each frame (background, sets, characters,
decorations); cards, text, icons and subtitles are drawn on a separate UI layer that is composited afterwards, so every
style keeps the clip readable. Nothing here generates images: each look is computed from the code-drawn frame itself
(downsampling, palettes, edge ink, halftone, dithering, faceting, blur masks and procedural paper/clay textures)."""
import math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageEnhance, ImageChops
from .core import W, H

STYLES = ('classic', 'pixel_art', 'ps2', 'comic', 'lego', 'claymation', 'paper_cutout', 'retro_anime', 'low_poly', 'risograph', 'diorama')
# stop-motion looks animate "on twos": the world is redrawn this many times per second (subtitles stay smooth)
HOLD = {'claymation': 12, 'paper_cutout': 10, 'retro_anime': 12, 'lego': 15, 'low_poly': 15}

_cache = {}


def _once(key, fn):
    if key not in _cache:
        _cache[key] = fn()
    return _cache[key]


def hold_time(style, t):
    fps = HOLD.get(style)
    return math.floor(t * fps + 1e-6) / fps if fps else t


def _jitter(t, amp, salt=0):
    r = random.Random(int(t * 1000) * 7 + salt)
    return r.randint(-amp, amp), r.randint(-amp, amp)


def _palette(colors):
    p = Image.new('P', (1, 1))
    flat = [c for rgb in colors for c in rgb]
    flat += list(colors[0]) * (256 - len(colors))
    p.putpalette(flat)
    return p


def _rgb(img):
    return img if img.mode == 'RGB' else img.convert('RGB')


def _edges(rgb, thresh=26, grow=3, scale=2):
    """Ink outline mask (L, 255 = ink) from colour edges, computed at reduced size for speed."""
    sm = rgb.resize((W // scale, H // scale), Image.BILINEAR).convert('L').filter(ImageFilter.FIND_EDGES)
    m = sm.point(lambda v: 255 if v > thresh else 0)
    if grow > 1:
        m = m.filter(ImageFilter.MaxFilter(grow))
    return m.resize((W, H), Image.BILINEAR).point(lambda v: 255 if v > 110 else 0)


def _vignette():
    y, x = np.mgrid[0:H, 0:W]
    d = np.sqrt(((x - W / 2) / (W * 0.62)) ** 2 + ((y - H / 2) / (H * 0.62)) ** 2)
    v = np.clip(1.0 - 0.32 * np.clip(d - 0.55, 0, 1) ** 1.4 * 2.2, 0.62, 1.0)
    g = (v * 255).astype(np.uint8)
    return Image.merge('RGB', [Image.fromarray(g, 'L')] * 3)


def _noise(seed, lo, hi, blur=0.0, size=(W, H)):
    rng = np.random.default_rng(seed)
    a = rng.integers(lo, hi + 1, size=(size[1], size[0]), dtype=np.int16).astype(np.uint8)
    im = Image.fromarray(a, 'L')
    return im.filter(ImageFilter.GaussianBlur(blur)) if blur else im


_BAYER8 = np.array([[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38],
                    [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
                    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]], np.float32) / 64.0


def _bayer(w, h):
    return np.tile(_BAYER8, (h // 8 + 1, w // 8 + 1))[:h, :w]


# ---------------------------------------------------------------- 01 pixel art
PIXEL_PAL = [(0, 0, 0), (34, 32, 52), (69, 40, 60), (102, 57, 49), (143, 86, 59), (223, 113, 38), (217, 160, 102), (238, 195, 154),
             (251, 242, 54), (153, 229, 80), (106, 190, 48), (55, 148, 110), (75, 105, 47), (82, 75, 36), (50, 60, 57), (63, 63, 116),
             (48, 96, 130), (91, 110, 225), (99, 155, 255), (95, 205, 228), (203, 219, 252), (255, 255, 255), (155, 173, 183), (132, 126, 135),
             (105, 106, 106), (89, 86, 82), (118, 66, 138), (172, 50, 50), (217, 87, 99), (215, 123, 186), (143, 151, 74), (138, 111, 48)]


def pixel_art(img, t):
    s = _rgb(img).resize((W // 7, H // 7), Image.BOX)
    q = s.quantize(palette=_once('pal_pixel', lambda: _palette(PIXEL_PAL)), dither=Image.Dither.NONE).convert('RGB')
    return q.resize((W, H), Image.NEAREST)


# ---------------------------------------------------------------- 02 PS2-era 3D
def ps2(img, t):
    s = _rgb(img).resize((W // 4, H // 4), Image.BILINEAR)
    s = ImageEnhance.Color(s).enhance(0.86)
    a = np.asarray(s, np.float32) + (_once('bayer_ps2', lambda: _bayer(W // 4, H // 4))[..., None] - 0.5) * 22
    a = (np.clip(a, 0, 255).astype(np.uint8) >> 3) << 3          # 15-bit colour like the console's framebuffer
    big = Image.fromarray(a, 'RGB').resize((W, H), Image.NEAREST).resize((W // 2, H // 2), Image.BILINEAR).resize((W, H), Image.BILINEAR)
    big = ImageEnhance.Contrast(big).enhance(1.08)
    fog = _once('ps2_fog', lambda: Image.fromarray(np.repeat((np.linspace(0.30, 0.04, H) * 255).astype(np.uint8)[:, None], W, 1), 'L'))
    big = Image.composite(Image.new('RGB', (W, H), (178, 196, 222)), big, fog)
    return ImageChops.multiply(big, _once('vignette', _vignette))


# ---------------------------------------------------------------- 03 comic art
def _dots():
    im = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(im)
    step = 14
    for j, y in enumerate(range(0, H + step, step)):
        off = step // 2 if j % 2 else 0
        for x in range(-step, W + step, step):
            d.ellipse((x + off - 3.6, y - 3.6, x + off + 3.6, y + 3.6), fill=224)
    return Image.merge('RGB', (im, im, im))


def comic(img, t):
    """Print colour and halftone over existing line art without re-inking it.

    Artkit drawings already contain outlines, facial features and sometimes text.
    Growing a second edge mask over them filled eye whites and letter counters,
    especially on small characters. Keep the original geometry and protect detail
    neighbourhoods from the texture as well.
    """
    rgb = _rgb(img)
    flat = Image.blend(rgb, ImageOps.posterize(ImageEnhance.Color(rgb).enhance(1.08), 4), 0.65)
    shade = rgb.convert('L').point(lambda v: 255 if 60 < v < 170 else 0)
    shade = ImageChops.subtract(shade, _edges(rgb, 24, 5))
    return Image.composite(ImageChops.multiply(flat, _once('dots', _dots)), flat, shade)


# ---------------------------------------------------------------- 04 brick mosaic
LEGO_PAL = [(242, 243, 242), (163, 162, 165), (99, 95, 98), (27, 42, 53), (196, 40, 28), (13, 105, 172), (245, 205, 48), (40, 127, 71),
            (218, 133, 65), (160, 95, 53), (232, 186, 145), (107, 50, 124), (146, 57, 120), (75, 151, 75), (110, 153, 202), (255, 148, 194),
            (164, 189, 71), (91, 93, 105), (0, 143, 155), (204, 142, 105)]
CELL = 24


def _studs():
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, 'RGBA')
    r = CELL * 0.31
    for y in range(0, H, CELL):
        for x in range(0, W, CELL):
            d.line((x, y + CELL - 1, x + CELL - 1, y + CELL - 1), fill=(0, 0, 0, 70), width=2)
            d.line((x + CELL - 1, y, x + CELL - 1, y + CELL - 1), fill=(0, 0, 0, 60), width=2)
            d.line((x, y, x + CELL - 2, y), fill=(255, 255, 255, 45))
            d.line((x, y, x, y + CELL - 2), fill=(255, 255, 255, 40))
            cx, cy = x + CELL / 2, y + CELL / 2
            d.ellipse((cx - r + 2, cy - r + 2, cx + r + 2, cy + r + 2), fill=(0, 0, 0, 70))
            d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, 80), width=2)
            d.arc((cx - r, cy - r, cx + r, cy + r), 200, 320, fill=(255, 255, 255, 140), width=2)
    return im


def lego_chars(chars, t):
    a = chars.getchannel('A')
    rgb = ImageOps.posterize(ImageEnhance.Contrast(chars.convert('RGB')).enhance(1.15), 4)
    hi, lo = _rim_light(a)      # light catches the top-left rims
    rgb = ImageChops.add(rgb, Image.merge('RGB', (hi, hi, hi)).point(lambda v: v // 2))
    rgb = ImageChops.subtract(rgb, Image.merge('RGB', (lo, lo, lo)).point(lambda v: v // 2))
    out = rgb.convert('RGBA')
    out.putalpha(a)
    return out


def lego(img, t):
    s = _rgb(img).resize((W // CELL, H // CELL), Image.BOX)
    q = s.quantize(palette=_once('pal_lego', lambda: _palette(LEGO_PAL)), dither=Image.Dither.NONE).convert('RGBA')
    big = q.resize((W, H), Image.NEAREST)
    big.alpha_composite(_once('studs', _studs))
    return big


# ---------------------------------------------------------------- 05 claymation
def _clay_tex():
    low = _noise(11, 205, 255, 0, (W // 8, H // 8)).filter(ImageFilter.GaussianBlur(2)).resize((W, H), Image.BICUBIC)
    fine = _noise(12, 228, 255, 1.2)
    tex = ImageChops.multiply(low, fine)
    d = ImageDraw.Draw(tex)
    rng = random.Random(13)
    for _ in range(260):   # thumbprints pressed into the clay
        x, y, r = rng.randint(0, W), rng.randint(0, H), rng.randint(8, 22)
        for k in range(3):
            rr = r - k * 5
            if rr > 2:
                d.arc((x - rr, y - rr * 0.8, x + rr, y + rr * 0.8), rng.randint(0, 90), rng.randint(200, 330), fill=200, width=2)
    tex = tex.filter(ImageFilter.GaussianBlur(0.8))
    return Image.merge('RGB', (tex, tex, tex))


def _bevel(rgb, depth=5, blur=7, k=1.4):
    """Light from the top-left on soft bumps made from the picture's own shapes: (highlight L, shadow L)."""
    L = rgb.resize((W // 2, H // 2), Image.BILINEAR).convert('L').filter(ImageFilter.GaussianBlur(blur / 2))
    a = np.asarray(L, np.float32)
    b = np.asarray(ImageChops.offset(L, depth // 2 or 1, depth // 2 or 1), np.float32)
    g = (a - b) * k
    hi = Image.fromarray(np.clip(g, 0, 255).astype(np.uint8), 'L').resize((W, H), Image.BILINEAR)
    lo = Image.fromarray(np.clip(-g, 0, 255).astype(np.uint8), 'L').resize((W, H), Image.BILINEAR)
    return hi, lo


def claymation(img, t):
    rgb = _rgb(img).filter(ImageFilter.GaussianBlur(0.9))
    rgb = ImageEnhance.Color(ImageEnhance.Contrast(rgb).enhance(1.06)).enhance(1.1)
    hi, lo = _bevel(rgb, 8, 10, 2.2)
    out = ImageChops.add(rgb, Image.merge('RGB', (hi, hi, hi)).point(lambda v: v // 2))
    out = ImageChops.subtract(out, Image.merge('RGB', (lo, lo, lo)).point(lambda v: int(v * 0.7)))
    out = ImageChops.multiply(out, _once('clay', _clay_tex))
    dx, dy = _jitter(t, 3, 5)
    return ImageChops.offset(out, dx, dy)


# ---------------------------------------------------------------- 06 paper cutout
def _paper_tex():
    base = _noise(21, 232, 255, 0.6)
    d = ImageDraw.Draw(base)
    rng = random.Random(22)
    for _ in range(900):   # paper fibres
        x, y = rng.randint(0, W), rng.randint(0, H)
        a = rng.uniform(0, math.pi)
        L = rng.randint(6, 26)
        d.line((x, y, x + math.cos(a) * L, y + math.sin(a) * L), fill=rng.randint(214, 236), width=1)
    return Image.merge('RGB', (base, base, base))


def paper_cutout(img, t):
    rgb = _rgb(img)
    flat = ImageOps.posterize(ImageEnhance.Color(rgb).enhance(1.1), 4)
    e = _edges(rgb, 20, 5, 2)
    sh = ImageChops.offset(e.resize((W // 2, H // 2), Image.BILINEAR).filter(ImageFilter.GaussianBlur(4)).resize((W, H), Image.BILINEAR), 9, 13)
    sh = ImageChops.subtract(sh, e).point(lambda v: int(v * 0.7))
    out = Image.composite(ImageChops.multiply(flat, Image.new('RGB', (W, H), (110, 100, 95))), flat, sh)
    out = ImageChops.multiply(out, _once('paper', _paper_tex))
    dx, dy = _jitter(t, 2, 9)
    return ImageChops.offset(out, dx, dy)


def _rim_light(a, r=9, d=7, k_hi=3, k_lo=2):
    """Rim light/shadow from a silhouette (computed at half size for speed)."""
    blur = a.resize((W // 2, H // 2), Image.BILINEAR).filter(ImageFilter.GaussianBlur(r / 2))
    h = max(1, d // 2)
    hi = ImageChops.subtract(blur, ImageChops.offset(blur, h, h)).point(lambda v: min(255, v * k_hi))
    lo = ImageChops.subtract(blur, ImageChops.offset(blur, -h, -h)).point(lambda v: min(255, v * k_lo))
    return hi.resize((W, H), Image.BILINEAR), lo.resize((W, H), Image.BILINEAR)


def paper_chars(chars, t):
    """Characters as cut-out paper puppets: flat colours, a white cut border and a real drop shadow from their silhouette."""
    a = chars.getchannel('A')
    flat = ImageOps.posterize(chars.convert('RGB'), 4)
    flat = ImageChops.multiply(flat, _once('paper', _paper_tex))
    small = a.resize((W // 2, H // 2), Image.BILINEAR).filter(ImageFilter.MaxFilter(5))
    border = small.resize((W, H), Image.BILINEAR).point(lambda v: 255 if v > 90 else 0)
    sh = ImageChops.offset(small, 5, 7).filter(ImageFilter.GaussianBlur(2.5)).resize((W, H), Image.BILINEAR).point(lambda v: int(v * 0.45))
    out = Image.new('RGBA', (W, H), (40, 30, 30, 0))
    out.putalpha(sh)
    paper = Image.new('RGBA', (W, H), (252, 250, 244, 0))
    paper.putalpha(border)
    out.alpha_composite(paper)
    c = flat.convert('RGBA')
    c.putalpha(a)
    out.alpha_composite(c)
    dx, dy = _jitter(t, 2, 9)
    return ImageChops.offset(out, dx, dy)


def clay_chars(chars, t):
    """Characters as plasticine puppets: rounded volume lit from the top-left, matte clay texture, same stop-motion wobble as the set."""
    a = chars.getchannel('A')
    rgb = ImageEnhance.Color(chars.convert('RGB').filter(ImageFilter.GaussianBlur(0.8))).enhance(1.1)
    hi, lo = _rim_light(a, 14, 9, 2, 2)
    rgb = ImageChops.add(rgb, Image.merge('RGB', (hi, hi, hi)).point(lambda v: v // 3))
    rgb = ImageChops.subtract(rgb, Image.merge('RGB', (lo, lo, lo)).point(lambda v: v // 2))
    rgb = ImageChops.multiply(rgb, _once('clay', _clay_tex))
    out = rgb.convert('RGBA')
    out.putalpha(a)
    dx, dy = _jitter(t, 3, 5)
    return ImageChops.offset(out, dx, dy)


# ---------------------------------------------------------------- 07 retro anime (80s/90s cel + VHS)
def _scan():
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for y in range(0, H, 4):
        d.line((0, y, W, y), fill=(0, 0, 0, 26))
    return im


def _lut(img, r, g, b):
    return Image.merge('RGB', [c.point(f) for c, f in zip(img.split(), (r, g, b))])


def retro_anime(img, t):
    rgb = _rgb(img)
    flat = ImageOps.posterize(rgb, 4)
    flat = _lut(flat, lambda v: min(255, int(v * 1.04 + 8)), lambda v: int(v * 0.97 + 6), lambda v: int(v * 0.88 + 30))   # warm highs, teal-lifted shadows
    flat = ImageEnhance.Color(flat).enhance(1.15)
    bright = flat.resize((W // 4, H // 4), Image.BILINEAR).point(lambda v: max(0, v - 170) * 3).filter(ImageFilter.GaussianBlur(6)).resize((W, H), Image.BILINEAR)
    flat = ImageChops.add(flat, bright.point(lambda v: v // 3))
    flat = Image.composite(Image.new('RGB', (W, H), (52, 30, 60)), flat, _edges(rgb, 28, 1, 2))
    r, g, b = flat.split()
    flat = Image.merge('RGB', (ImageChops.offset(r, 3, 0), g, ImageChops.offset(b, -3, 0)))   # slight colour fringing
    grains = _once('grain', lambda: [_noise(31 + i, 0, 40, 0.5) for i in range(4)])
    flat = ImageChops.subtract(flat, Image.merge('RGB', [grains[int(t * 12) % 4]] * 3), 1, 12)
    out = flat.convert('RGBA')
    out.alpha_composite(_once('scan', _scan))
    return out


# ---------------------------------------------------------------- 08 low-poly 3D
def _mesh(step, seed=41):
    """Jittered triangle mesh as an id map (H x W int32) plus a per-facet light factor (fake 3D normals)."""
    rng = random.Random(seed)
    cols, rows = W // step + 2, H // step + 2
    pts = {}
    for j in range(rows):
        for i in range(cols):
            x, y = i * step, j * step
            if 0 < i < cols - 1 and 0 < j < rows - 1:
                x += rng.uniform(-step * 0.38, step * 0.38)
                y += rng.uniform(-step * 0.38, step * 0.38)
            pts[i, j] = (x, y, rng.uniform(0, 1))
    light = np.array([-0.45, -0.6, 0.66])
    light /= np.linalg.norm(light)
    idmap = Image.new('I', (W, H), 0)
    d = ImageDraw.Draw(idmap)
    shades = [1.0]
    for j in range(rows - 1):
        for i in range(cols - 1):
            a, b, c, e = pts[i, j], pts[i + 1, j], pts[i, j + 1], pts[i + 1, j + 1]
            for tri in ((a, b, c), (b, e, c)) if (i + j) % 2 else ((a, b, e), (a, e, c)):
                p = np.array([[q[0], q[1], q[2] * step * 0.8] for q in tri])
                n = np.cross(p[1] - p[0], p[2] - p[0])
                n = n / (np.linalg.norm(n) or 1)
                if n[2] < 0:
                    n = -n
                shades.append(0.84 + 0.3 * max(0.0, float(n @ light)))
                d.polygon([(q[0], q[1]) for q in tri], fill=len(shades) - 1)
    ids = np.asarray(idmap, np.int32)
    return ids, np.array(shades, np.float32)


def _facet(rgb, alpha, step):
    ids, sh = _once(('mesh', step), lambda: _mesh(step, 41 + step))
    n = len(sh)
    a = np.asarray(rgb, np.float32)
    w = np.ones(ids.shape, np.float32) if alpha is None else np.asarray(alpha, np.float32) / 255.0
    flat = ids.ravel()
    wsum = np.bincount(flat, weights=w.ravel(), minlength=n) + 1e-6
    cols = np.stack([np.bincount(flat, weights=(a[..., c] * w).ravel(), minlength=n) / wsum for c in range(3)], 1)
    cols = np.clip(cols * sh[:, None], 0, 255).astype(np.uint8)
    return Image.fromarray(cols[ids], 'RGB')


def low_poly(img, t):
    return _facet(_rgb(img), None, 34)


def low_poly_chars(chars, t):
    """Characters: a finer mesh inside their own silhouette, with a crisp outline so they stay recognisable."""
    a = chars.getchannel('A')
    out = _facet(chars.convert('RGB'), a, 13).convert('RGBA')
    out.putalpha(a)
    edge = a.filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 60 else 0)
    ink = Image.new('RGBA', (W, H), (34, 26, 44, 255))
    ink.putalpha(edge)
    out.alpha_composite(ink)
    return out


# ---------------------------------------------------------------- 09 risograph (two inks, grain, misregistration)
def risograph(img, t):
    L = ImageEnhance.Contrast(_rgb(img).resize((W // 2, H // 2), Image.BILINEAR).convert('L')).enhance(1.25)
    a = np.asarray(L, np.float32) / 255.0
    th = _once('bayer_riso', lambda: _bayer(W // 2, H // 2))
    pink = ((1.0 - a) * 1.15) > th                               # mid-tones and darks
    blue = np.clip((0.55 - a) / 0.4, 0, 1) > th                 # darks only
    def up(m):
        return Image.fromarray((m * 255).astype(np.uint8), 'L').resize((W, H), Image.NEAREST)
    paper = Image.new('RGB', (W, H), (246, 240, 226))
    out = Image.composite(ImageChops.multiply(paper, Image.new('RGB', (W, H), (255, 92, 160))), paper, up(pink))
    out = Image.composite(ImageChops.multiply(out, Image.new('RGB', (W, H), (40, 108, 200))), out, ImageChops.offset(up(blue), 6, 4))
    return out


# ---------------------------------------------------------------- 10 miniature diorama (tilt-shift)
def _tilt():
    y = np.arange(H, dtype=np.float32)
    top = np.clip((720 - y) / 380, 0, 1)
    bot = np.clip((y - 1420) / 380, 0, 1)
    m = (np.maximum(top, bot) ** 0.9 * 255).astype(np.uint8)
    return Image.fromarray(np.repeat(m[:, None], W, 1), 'L')


def diorama(img, t):
    rgb = ImageEnhance.Contrast(ImageEnhance.Color(_rgb(img)).enhance(1.4)).enhance(1.12)
    blur = rgb.resize((W // 4, H // 4), Image.BILINEAR).filter(ImageFilter.GaussianBlur(3)).resize((W, H), Image.BILINEAR)
    out = Image.composite(blur, rgb, _once('tilt', _tilt))
    return ImageChops.multiply(out, _once('vignette', _vignette))


FUNCS = {'pixel_art': pixel_art, 'ps2': ps2, 'comic': comic, 'lego': lego, 'claymation': claymation, 'paper_cutout': paper_cutout,
         'retro_anime': retro_anime, 'low_poly': low_poly, 'risograph': risograph, 'diorama': diorama}
# styles that would make characters unrecognisable treat them separately (bricks/facets are too coarse for a face)
CHAR_FUNCS = {'lego': lego_chars, 'low_poly': low_poly_chars, 'paper_cutout': paper_chars, 'claymation': clay_chars}


def apply(style, world, chars=None, t=0.0):
    """Return the picture in the given style as RGBA. `chars` is an optional RGBA layer with the characters (drawn over the world).
    'classic' or an unknown name returns world + characters unchanged."""
    fn = FUNCS.get(style)
    world = world if world.mode == 'RGBA' else world.convert('RGBA')
    if not fn:
        if chars is not None:
            world = world.copy()
            world.alpha_composite(chars)
        return world
    if chars is not None and style in CHAR_FUNCS:
        out = fn(world, t)
        out = out if out.mode == 'RGBA' else out.convert('RGBA')
        out.alpha_composite(CHAR_FUNCS[style](chars, t))
        return out
    if chars is not None:
        world = world.copy()
        world.alpha_composite(chars)
    out = fn(world, t)
    return out if out.mode == 'RGBA' else out.convert('RGBA')
