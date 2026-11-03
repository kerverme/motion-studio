"""Motion Studio engine core: code-drawn motion graphics primitives, timeline access,
subtitles and transitions. Everything visual is drawn procedurally with Pillow."""
import json, math, random, sys, os, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS = 1080, 1920, 30
K = 2  # supersample factor for characters
FD = os.environ.get('MOTION_FONT_DIR') or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'fonts')

# ---- timeline state (filled by load_timeline before episode code runs)
END = 0.0
TIM, SEG, ORDER, STARTS, PHRASES, WORDS = [], {}, [], [], [], []
SERIES_TAG = 'จะเกิดอะไรขึ้นถ้า...?'
MISSING_WORDS = []


def load_timeline(timeline, end=None, series_tag=None):
    """timeline: list of segments {id,s,e,phrases:[{text,s,e,words:[{w,s,e}]}]}"""
    global END, TIM, SEG, ORDER, STARTS, PHRASES, WORDS, SERIES_TAG
    TIM[:] = timeline
    SEG.clear(); SEG.update({s['id']: s for s in TIM})
    ORDER[:] = [s['id'] for s in TIM]
    STARTS[:] = [0.0] + [s['s'] for s in TIM[1:]]
    PHRASES[:] = [p for s in TIM for p in s['phrases']]
    WORDS[:] = [w for p in PHRASES for w in p['words']]
    END = float(end if end is not None else (TIM[-1]['e'] + 1.8))
    if series_tag is not None:
        SERIES_TAG = series_tag


def wt(seg, word, n=0):
    """Start time of the n-th occurrence of `word` in segment `seg`.
    Falls back to a partial match, then to the segment start, so a re-voiced
    narration never crashes the render (misses are reported to QA)."""
    k = 0
    for p in SEG[seg]['phrases']:
        for w in p['words']:
            if w['w'] == word:
                if k == n:
                    return w['s']
                k += 1
    k = 0
    for p in SEG[seg]['phrases']:
        for w in p['words']:
            if word in w['w'] or w['w'] in word:
                if k == n:
                    return w['s']
                k += 1
    if (seg, word, n) not in MISSING_WORDS:
        MISSING_WORDS.append((seg, word, n))
    return SEG[seg]['s']


# ---------------------------------------------------------------- helpers
_fonts = {}
def F(size, weight=800):
    key = (size, weight)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(os.path.join(FD, f'Kanit-{weight}.ttf'), size)
    return _fonts[key]


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))

def lerp(a, b, x):
    return a + (b - a) * x

def eo(x):  # ease out cubic
    x = clamp(x); return 1 - (1 - x) ** 3

def eio(x):
    x = clamp(x); return 3 * x * x - 2 * x * x * x

def eob(x):  # ease out back
    x = clamp(x); c1 = 1.9; c3 = c1 + 1
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2

def pop(t, t0, d=0.32):
    if t < t0: return 0.0
    return eob((t - t0) / d)

def fade(t, t0, d=0.25):
    return eo((t - t0) / d) if t >= t0 else 0.0


_timg = {}
def text_img(txt, size, weight=800, fill=(255, 255, 255), stroke=0, sfill=(0, 0, 0)):
    key = (txt, size, weight, fill, stroke, sfill)
    if key in _timg: return _timg[key]
    f = F(size, weight)
    l, tp, r, b = f.getbbox(txt, stroke_width=stroke)
    pad = 6 + stroke
    im = Image.new('RGBA', (r - l + 2 * pad, b - tp + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.text((pad - l, pad - tp), txt, font=f, fill=fill, stroke_width=stroke, stroke_fill=sfill)
    _timg[key] = im
    return im


def comp(dst, src, x, y):
    """alpha-composite src onto dst at integer x,y with clipping."""
    x, y = int(round(x)), int(round(y))
    sw, sh = src.size
    l, t = max(0, -x), max(0, -y)
    r, b = min(sw, dst.width - x), min(sh, dst.height - y)
    if r <= l or b <= t: return
    if (l, t, r, b) != (0, 0, sw, sh):
        src = src.crop((l, t, r, b))
    dst.alpha_composite(src, (x + l, y + t))


def put(dst, im, cx, cy, scale=1.0, alpha=1.0, rot=0.0):
    if scale <= 0.01 or alpha <= 0.01: return
    if abs(scale - 1) > 0.005:
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.BILINEAR)
    if rot:
        im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
    if alpha < 0.999:
        a = im.getchannel('A').point(lambda v: int(v * alpha))
        im = im.copy(); im.putalpha(a)
    comp(dst, im, cx - im.width / 2, cy - im.height / 2)


def ptext(dst, txt, cx, cy, size, t, t0, weight=800, fill=(255, 255, 255), stroke=8, sfill=(30, 20, 60), rot=0.0, alpha=1.0, d=0.32):
    s = pop(t, t0, d)
    if s <= 0: return
    put(dst, text_img(txt, size, weight, fill, stroke, sfill), cx, cy, s, alpha, rot)


def rrect(d, box, r, fill, outline=None, width=0):
    d.rounded_rectangle(box, r, fill=fill, outline=outline, width=width)


_bgs = {}
def gradient(top, bot):
    key = (top, bot)
    if key not in _bgs:
        y = np.linspace(0, 1, H)[:, None, None]
        a = np.array(top, float)[None, None, :]; b = np.array(bot, float)[None, None, :]
        g = (a * (1 - y) + b * y).repeat(W, 1)
        alpha = np.full((H, W, 1), 255.0)
        _bgs[key] = Image.fromarray(np.concatenate([g, alpha], 2).astype(np.uint8), 'RGBA')
    return _bgs[key].copy()


# ---------------------------------------------------------------- talking
def talk_amount(t):
    for w in WORDS:
        if w['s'] - 0.02 <= t <= w['e']:
            dur = max(0.08, w['e'] - w['s'])
            n = max(1, round(dur / 0.17))
            return abs(math.sin(math.pi * n * (t - w['s']) / dur)) * 0.85 + 0.15
    return 0.0


# ---------------------------------------------------------------- jelly cat
JELLY = {
    'mint': ((120, 226, 204), (34, 128, 118), (205, 255, 240)),
    'peach': ((255, 186, 160), (176, 84, 70), (255, 232, 220)),
    'ghost': ((236, 240, 255), (170, 180, 230), (255, 255, 255)),
    'grey': ((190, 196, 205), (110, 116, 128), (235, 238, 242)),
}

def draw_cat(base, cx, cy, S, t, mood='normal', talk=0.0, rot=0.0, sq=1.0, spread=0.0,
             alpha=1.0, kind='mint', look=(0.0, 0.0), jig=1.0, halo=False, wave=0.0, prop=None):
    S = max(20, S)
    galpha, alpha = alpha, 1.0
    L = int(S * 2.4 * K)
    s = S * K
    lay = Image.new('RGBA', (L, L), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay, 'RGBA')
    ox, oy = L / 2, L / 2 + 0.05 * s
    fill, line, glow = JELLY[kind]
    def mix(c, a):
        a = a / 255.0
        return tuple(int(fill[i] * (1 - a) + c[i] * a) for i in range(3)) + (255,)
    A = 255
    sy = sq * (1 - 0.32 * spread)
    sx = (1 / max(0.3, sq) ** 0.6) * (1 + 0.5 * spread)
    lw = max(2, int(0.024 * s))

    # tail (behind)
    sway = math.sin(t * 3.1) * 0.12
    tail = []
    for i in range(14):
        u = i / 13
        tx = (0.36 + 0.32 * u) * s * sx
        ty = (0.22 - 0.55 * u ** 1.3 + sway * u * u) * s * sy
        tail.append((ox + tx, oy + ty, (0.085 - 0.03 * u) * s))
    for x, y, r in tail:
        d.ellipse((x - r - lw, y - r - lw, x + r + lw, y + r + lw), fill=line + (int(255 * alpha),))
    for x, y, r in tail:
        d.ellipse((x - r, y - r, x + r, y + r), fill=fill + (255 if alpha >= 1 else int(255 * alpha),))

    # spread limbs (behind body)
    if spread > 0.02:
        for sgn in (-1, 1):
            for vy in (-0.12, 0.16):
                lx = ox + sgn * (0.5 + 0.18 * spread) * s * sx * 0.85
                ly = oy + vy * s * sy
                rx, ry = 0.13 * s * spread + 0.02 * s, 0.06 * s
                d.ellipse((lx - rx - lw, ly - ry - lw, lx + rx + lw, ly + ry + lw), fill=line + (int(255 * alpha),))
                d.ellipse((lx - rx, ly - ry, lx + rx, ly + ry), fill=fill + (int(255 * alpha),))

    # body with ears
    pts = []
    N = 140
    th1, th2 = -math.pi * 0.31, -math.pi * 0.69
    for i in range(N):
        th = 2 * math.pi * i / N - math.pi
        bx, by = math.cos(th) * 0.5, math.sin(th) * 0.42
        if by > 0: by *= 0.84
        wob = 1 + jig * (0.03 * math.sin(3 * th + 7 * t) + 0.018 * math.sin(5 * th - 5 * t))
        e = 0.46 * (math.exp(-((th - th1) / 0.165) ** 2) + math.exp(-((th - th2) / 0.165) ** 2))
        r = wob + e
        pts.append((ox + bx * r * s * sx, oy + by * r * s * sy))
    d.polygon(pts, fill=fill + (A,))
    # inner glow
    gp = [(ox + (x - ox) * 0.74, oy - 0.05 * s + (y - oy) * 0.7) for x, y in pts]
    d.polygon(gp, fill=mix(glow, 80))
    d.line(pts + [pts[0]], fill=line + (int(255 * alpha),), width=lw, joint='curve')

    # inner ears
    for th in (th1, th2):
        def P(tt, rr):
            bx, by = math.cos(tt) * 0.5, math.sin(tt) * 0.42
            return (ox + bx * rr * s * sx, oy + by * rr * s * sy)
        d.polygon([P(th, 1.30), P(th - 0.15, 0.98), P(th + 0.15, 0.98)], fill=mix((255, 160, 185), 170))

    # bubbles
    rnd = random.Random(7)
    for i in range(5):
        bx = rnd.uniform(-0.28, 0.28)
        ph = rnd.uniform(0, 1)
        by = 0.25 - ((t * 0.18 + ph) % 1.0) * 0.5
        br = rnd.uniform(0.016, 0.032)
        x, y = ox + bx * s * sx, oy + by * s * sy
        d.ellipse((x - br * s, y - br * s, x + br * s, y + br * s), outline=mix((255, 255, 255), 150), width=max(1, int(0.008 * s)))

    # specular
    x, y = ox - 0.26 * s * sx, oy - 0.19 * s * sy
    d.ellipse((x - 0.07 * s, y - 0.035 * s, x + 0.07 * s, y + 0.035 * s), fill=mix((255, 255, 255), 210))
    x, y = ox - 0.13 * s * sx, oy - 0.27 * s * sy
    d.ellipse((x - 0.02 * s, y - 0.02 * s, x + 0.02 * s, y + 0.02 * s), fill=mix((255, 255, 255), 220))

    # face
    fx = ox + look[0] * 0.05 * s
    fy = oy + 0.02 * s * sy + look[1] * 0.04 * s
    ex = 0.16 * s * min(1.25, sx)
    ey = fy - 0.04 * s * sy
    ink = (40, 30, 50, int(255 * alpha))
    blink = (t % 3.7) < 0.11 and mood in ('normal', 'worried')
    for sgn in (-1, 1):
        cx_ = fx + sgn * ex
        if mood == 'happy' or blink:
            if blink:
                d.line((cx_ - 0.05 * s, ey, cx_ + 0.05 * s, ey), fill=ink, width=lw)
            else:
                d.arc((cx_ - 0.055 * s, ey - 0.04 * s, cx_ + 0.055 * s, ey + 0.05 * s), 200, 340, fill=ink, width=int(lw * 1.2))
        elif mood == 'shock':
            r = 0.075 * s
            d.ellipse((cx_ - r, ey - r, cx_ + r, ey + r), fill=(255, 255, 255, int(255 * alpha)), outline=ink, width=lw)
            r2 = 0.026 * s
            d.ellipse((cx_ - r2, ey - r2, cx_ + r2, ey + r2), fill=ink)
        else:
            r = 0.06 * s
            d.ellipse((cx_ - r, ey - r, cx_ + r, ey + r), fill=ink)
            r2 = 0.022 * s
            d.ellipse((cx_ - 0.022 * s - r2, ey - 0.024 * s - r2, cx_ - 0.022 * s + r2, ey - 0.024 * s + r2), fill=(255, 255, 255, int(255 * alpha)))
            if mood == 'worried':
                d.line((cx_ - sgn * 0.06 * s, ey - 0.12 * s, cx_ + sgn * 0.05 * s, ey - 0.09 * s), fill=ink, width=lw)
    # cheeks
    for sgn in (-1, 1):
        x, y = fx + sgn * 0.27 * s * min(1.2, sx), fy + 0.06 * s
        d.ellipse((x - 0.06 * s, y - 0.032 * s, x + 0.06 * s, y + 0.032 * s), fill=mix((255, 130, 160), 120))
    # mouth
    my = fy + 0.055 * s
    if talk > 0.05 or mood == 'shock':
        op = max(talk, 0.6 if mood == 'shock' else 0)
        hh = 0.02 * s + 0.085 * s * op
        d.ellipse((fx - 0.05 * s, my - 0.005 * s, fx + 0.05 * s, my + hh), fill=(120, 36, 60, int(255 * alpha)))
        d.ellipse((fx - 0.03 * s, my + hh * 0.55, fx + 0.03 * s, my + hh * 0.95), fill=(255, 120, 140, int(255 * alpha)))
    for sgn in (-1, 1):
        cxm = fx + sgn * 0.035 * s
        d.arc((cxm - 0.037 * s, my - 0.04 * s, cxm + 0.037 * s, my + 0.02 * s), 20, 160, fill=ink, width=lw)
    # whiskers
    for sgn in (-1, 1):
        for k2, dy in enumerate((-0.03, 0.0, 0.03)):
            x0 = fx + sgn * 0.31 * s * min(1.2, sx)
            d.line((x0, fy + dy * s + 0.02 * s, x0 + sgn * 0.14 * s, fy + dy * 2.2 * s), fill=mix(line, 170), width=max(1, lw // 2))
    # paws
    if spread < 0.5:
        for sgn in (-1, 1):
            px = ox + sgn * 0.15 * s * sx
            py = oy + 0.33 * s * sy
            wv = (wave * math.sin(t * 9) * 0.08 * s) if sgn > 0 else 0
            rx, ry = 0.075 * s, 0.05 * s
            d.ellipse((px - rx - lw * .6, py - ry - lw * .6 - wv, px + rx + lw * .6, py + ry + lw * .6 - wv), fill=line + (int(255 * alpha),))
            d.ellipse((px - rx, py - ry - wv, px + rx, py + ry - wv), fill=glow + (int(255 * alpha),))
    # props
    if prop == 'clipboard':
        bx0, by0 = ox + 0.2 * s, oy + 0.02 * s
        d.rounded_rectangle((bx0, by0, bx0 + 0.3 * s, by0 + 0.38 * s), int(0.03 * s), fill=(180, 120, 70, 255), outline=(90, 55, 30, 255), width=lw)
        d.rectangle((bx0 + 0.03 * s, by0 + 0.06 * s, bx0 + 0.27 * s, by0 + 0.35 * s), fill=(255, 255, 255, 255))
        d.rounded_rectangle((bx0 + 0.09 * s, by0 - 0.02 * s, bx0 + 0.21 * s, by0 + 0.04 * s), int(0.01 * s), fill=(120, 120, 130, 255))
        for i in range(4):
            yy = by0 + (0.11 + 0.06 * i) * s
            d.line((bx0 + 0.06 * s, yy, bx0 + 0.24 * s, yy), fill=(120, 140, 170, 255), width=max(1, lw // 2))
    if halo:
        hy = oy - 0.62 * s * sy
        d.ellipse((ox - 0.2 * s, hy - 0.05 * s, ox + 0.2 * s, hy + 0.05 * s), outline=(255, 230, 120, int(255 * min(1, alpha * 2.2))), width=int(lw * 1.4))

    if rot:
        lay = lay.rotate(rot, resample=Image.BICUBIC, center=(ox, oy))
    lay = lay.reduce(K)
    if galpha < 0.999:
        lay.putalpha(lay.getchannel('A').point(lambda v: int(v * galpha)))
    comp(base, lay, cx - ox / K, cy - oy / K)


# ---------------------------------------------------------------- small icons
def speed_lines(d, cx, cy, t, n=14, spread=420, col=(255, 255, 255, 140), up=True):
    rnd = random.Random(3)
    for i in range(n):
        x = cx + rnd.uniform(-spread, spread)
        ph = rnd.uniform(0, 1)
        ln = rnd.uniform(80, 200)
        y = cy + 700 - ((t * 2.2 + ph) % 1.0) * 1400 if up else cy - 700 + ((t * 2.2 + ph) % 1.0) * 1400
        d.line((x, y, x, y + ln), fill=col, width=6)


def cloud(d, x, y, sc, a=230):
    for dx, dy, r in ((0, 0, 60), (60, -25, 70), (130, 0, 58), (65, 20, 60)):
        d.ellipse((x + dx * sc - r * sc, y + dy * sc - r * sc, x + dx * sc + r * sc, y + dy * sc + r * sc), fill=(255, 255, 255, a))


def comment_icon(d, cx, cy, sc, col=(255, 255, 255, 255), ink=(60, 40, 90, 255)):
    w, h = 150 * sc, 110 * sc
    d.rounded_rectangle((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), int(40 * sc), fill=col, outline=ink, width=max(2, int(7 * sc)))
    d.polygon([(cx - 30 * sc, cy + h / 2 - 4), (cx - 55 * sc, cy + h / 2 + 38 * sc), (cx + 5 * sc, cy + h / 2 - 4)], fill=col)
    d.line([(cx - 30 * sc, cy + h / 2), (cx - 55 * sc, cy + h / 2 + 38 * sc), (cx + 5 * sc, cy + h / 2)], fill=ink, width=max(2, int(7 * sc)))
    for k2 in (-1, 0, 1):
        r = 11 * sc
        d.ellipse((cx + k2 * 38 * sc - r, cy - r, cx + k2 * 38 * sc + r, cy + r), fill=ink)


def heart(d, cx, cy, r, col):
    d.ellipse((cx - r, cy - r * 0.9, cx, cy + r * 0.1), fill=col)
    d.ellipse((cx, cy - r * 0.9, cx + r, cy + r * 0.1), fill=col)
    d.polygon([(cx - r * 0.97, cy - r * 0.25), (cx + r * 0.97, cy - r * 0.25), (cx, cy + r * 0.95)], fill=col)


def arrow(d, x0, y0, x1, y1, col, w=12, head=34):
    d.line((x0, y0, x1, y1), fill=col, width=w)
    ang = math.atan2(y1 - y0, x1 - x0)
    p1 = (x1 + head * math.cos(ang), y1 + head * math.sin(ang))
    p2 = (x1 + head * 0.8 * math.cos(ang + 2.4), y1 + head * 0.8 * math.sin(ang + 2.4))
    p3 = (x1 + head * 0.8 * math.cos(ang - 2.4), y1 + head * 0.8 * math.sin(ang - 2.4))
    d.polygon([p1, p2, p3], fill=col)


_icons = {}
def cat_icon(kind, size):
    key = (kind, size)
    if key not in _icons:
        im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        draw_cat(im, size / 2, size / 2 + size * 0.04, size * 0.58, 0.0, mood='happy' if kind != 'grey' else 'normal', kind=kind, jig=0)
        _icons[key] = im
    return _icons[key]


def confetti(d, t, t0, cx, cy, n=60):
    if t < t0 or t > t0 + 2.2: return
    u = t - t0
    rnd = random.Random(11)
    cols = [(255, 214, 0), (255, 90, 120), (90, 210, 255), (140, 255, 160), (255, 255, 255)]
    for i in range(n):
        ang = rnd.uniform(-math.pi, 0)
        v = rnd.uniform(500, 1100)
        x = cx + math.cos(ang) * v * u
        y = cy + math.sin(ang) * v * u + 900 * u * u
        sz = rnd.uniform(10, 20)
        a = int(255 * clamp(1 - u / 2.2))
        c = cols[i % len(cols)]
        d.rectangle((x, y, x + sz, y + sz * 0.6), fill=c + (a,))


def stars(d, t, n=50):
    rnd = random.Random(5)
    for i in range(n):
        x, y = rnd.uniform(0, W), rnd.uniform(0, 900)
        r = rnd.uniform(2, 5)
        a = int(140 + 110 * math.sin(t * rnd.uniform(1, 3) + i))
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 230, a))


def rays(d, cx, cy, t, col, n=16):
    for i in range(n):
        a0 = t * 0.4 + i * 2 * math.pi / n
        a1 = a0 + math.pi / n * 0.8
        R = 1600
        d.polygon([(cx, cy), (cx + R * math.cos(a0), cy + R * math.sin(a0)), (cx + R * math.cos(a1), cy + R * math.sin(a1))], fill=col)


# ---------------------------------------------------------------- common overlays
SUB_Y = 1475

def series_tag(img, d):
    tim = text_img(SERIES_TAG, 40, 700, (40, 30, 70), 0)
    w = tim.width + 40
    rrect(d, (540 - w / 2, 128, 540 + w / 2, 128 + tim.height + 8), 30, (255, 225, 60, 240))
    comp(img, tim, 540 - tim.width / 2, 132)


def subtitles(img, t):
    cur = None
    for i, p in enumerate(PHRASES):
        nxt = PHRASES[i + 1]['s'] if i + 1 < len(PHRASES) else END
        stop = min(nxt, p['e'] + 0.9)
        if p['s'] - 0.06 <= t < stop:
            cur = p
    if cur is None: return
    size = 74
    f = F(size, 800)
    words = cur['words']
    widths = [f.getlength(w['w']) for w in words]
    tot = sum(widths)
    if tot <= 880:
        lines = [(list(zip(words, widths)), tot)]
    else:
        best, bi = 1e9, 1
        acc = 0
        for i in range(1, len(words)):
            acc += widths[i - 1]
            m = max(acc, tot - acc)
            if m < best: best, bi = m, i
        a = list(zip(words, widths))
        lines = [(a[:bi], sum(widths[:bi])), (a[bi:], sum(widths[bi:]))]
    lh = 100
    total_h = lh * len(lines)
    s_in = eob((t - cur['s'] + 0.06) / 0.16)
    lay = Image.new('RGBA', (W, total_h + 80), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay, 'RGBA')
    maxw = max(l for _, l in lines)
    rrect(d, (540 - maxw / 2 - 34, 10, 540 + maxw / 2 + 34, total_h + 54), 34, (15, 10, 30, 150))
    y = 22
    for ln, lwid in lines:
        x = 540 - lwid / 2
        for w, wd in ln:
            spoken = t >= w['s']
            active = w['s'] <= t <= w['e'] + 0.08
            col = (255, 222, 40) if spoken else (255, 255, 255)
            yy = y - (8 if active else 0)
            d.text((x, yy), w['w'], font=f, fill=col, stroke_width=7, stroke_fill=(20, 10, 30))
            x += wd
        y += lh
    if s_in < 0.999:
        lay = lay.resize((int(W * s_in) or 1, int(lay.height * s_in) or 1), Image.BILINEAR)
    comp(img, lay, 540 - lay.width / 2, SUB_Y - lay.height / 2)




# ---------------------------------------------------------------- SVG (code-written vector art)
_svgs = {}
def svg_img(svg, width, height=None):
    """Rasterise SVG markup written in code to an RGBA image (cached)."""
    key = (svg, width, height)
    if key not in _svgs:
        import io, cairosvg
        png = cairosvg.svg2png(bytestring=svg.encode('utf-8'), output_width=int(width), output_height=int(height) if height else None)
        _svgs[key] = Image.open(io.BytesIO(png)).convert('RGBA')
    return _svgs[key]
