"""Data-driven scene templates for generated episodes.

A generated episode describes every narration segment as a small JSON spec (see TEMPLATE_DOC in the API's generator);
build_scenes(spec) turns it into the SCENES mapping engine.render expects. Everything is drawn procedurally
(Pillow + code-written SVG icons). Every animation is keyed to a word of the real narration through at(), which tries
the exact token, then a spaces-free substring match across tokens, then the word's relative position in the segment
text, so an edited or re-voiced script never crashes the render (misses are reported to QA)."""
import math, random, re, sys, traceback
from PIL import Image, ImageDraw, ImageFilter
from . import core
from .core import (W, H, SEG, clamp, lerp, eo, eio, eob, pop, fade, text_img, F, rrect,
                   talk_amount, arrow, confetti, rays, heart, comment_icon, stars)
from .core import put as _core_put, draw_cat as _core_draw_cat
from .characters import draw_person as _draw_person, look_style
from .props import check, stamp as _props_stamp

# When a visual style is active, cards, text, icons and stamps that templates place on the frame go to a separate UI layer, which
# the renderer composites crisply over the styled world (backgrounds, sets, characters). With the classic style nothing changes.
# Characters go to their own layer too, so styles that would make a face unrecognisable (bricks, facets) can treat them separately.
UI = {'base': None, 'layer': None, 'chars': None}


def _ui(dst):
    return UI['layer'] if UI['layer'] is not None and dst is UI['base'] else dst


def _chars(dst):
    return UI['chars'] if UI['chars'] is not None and dst is UI['base'] else dst


def draw_person(img, *a, **k):
    return _draw_person(_chars(img), *a, **k)


def draw_cat(img, *a, **k):
    return _core_draw_cat(_chars(img), *a, **k)


def put(dst, im, cx, cy, scale=1.0, alpha=1.0, rot=0.0):
    return _core_put(_ui(dst), im, cx, cy, scale, alpha, rot)


def stamp(img, *a, **k):
    return _props_stamp(_ui(img), *a, **k)
from .icons import icon, NAMES as ICON_NAMES
from .sets import draw_set, SETS

INK = (30, 22, 50)
YEL = (255, 225, 60)
WHITE = (255, 255, 255)
COLORS = {'yellow': YEL, 'white': WHITE, 'pink': (255, 130, 170), 'cyan': (110, 230, 255), 'green': (120, 235, 160),
          'red': (255, 95, 105), 'orange': (255, 170, 70)}
ACCENTS = [(255, 95, 115), (60, 170, 255), (50, 190, 135), (255, 160, 40), (150, 110, 255), (255, 120, 200)]
PALETTES = {
    'night': ((28, 22, 64), (92, 52, 128)), 'grape': ((72, 40, 140), (196, 92, 168)), 'ocean': ((16, 64, 132), (36, 160, 184)),
    'mint': ((18, 104, 100), (96, 196, 160)), 'sunset': ((214, 84, 84), (252, 176, 92)), 'sky': ((52, 128, 214), (150, 206, 250)),
    'peach': ((214, 98, 120), (250, 186, 150)), 'forest': ((18, 66, 50), (64, 140, 86)), 'ink': ((16, 16, 30), (52, 40, 86)),
    'gold': ((140, 84, 20), (232, 178, 64)), 'berry': ((110, 24, 72), (226, 82, 120)), 'teal': ((10, 80, 96), (40, 168, 160)),
}
PAL_ORDER = ['night', 'grape', 'ocean', 'sunset', 'mint', 'berry', 'sky', 'teal', 'peach', 'gold', 'forest', 'ink']
ERRORS = []      # template exceptions (reported once per scene, the frame falls back to a plain title card)
_TEXT = {}       # segment id -> narration text (for position-based fallback timing)
_CACHE = {}

# ---------------------------------------------------------------- timing
_STRIP = re.compile(r'[\s\.\?\!…,"“”\'\(\)\[\]:;\-–—!]')

def _norm(s):
    return _STRIP.sub('', str(s))


def at(seg, a, default=0.0, n=0):
    """Absolute time for a cue inside segment `seg`: a word/phrase of the narration, or a 0..1 fraction of the segment."""
    S = SEG[seg]
    s0, s1 = S['s'], S['e']
    if a is None or a == '':
        return s0 + default * (s1 - s0)
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        return s0 + clamp(float(a)) * (s1 - s0)
    if isinstance(a, dict):
        return at(seg, a.get('at'), default, int(a.get('n', 0) or 0))
    key = (seg, str(a), n)
    if key in _CACHE:
        return _CACHE[key]
    words = [w for p in S['phrases'] for w in p['words']]
    joined, owner = '', []
    for i, w in enumerate(words):
        nw = _norm(w['w'])
        joined += nw
        owner += [i] * len(nw)
    q = _norm(a)
    t = None
    if q:
        idx, start = -1, 0
        for _ in range(n + 1):
            idx = joined.find(q, start)
            if idx < 0:
                break
            start = idx + 1
        if idx >= 0:
            t = words[owner[idx]]['s']
        else:
            txt = _norm(_TEXT.get(seg, ''))
            j = txt.find(q)
            if j >= 0 and txt:
                t = s0 + (j / len(txt)) * (s1 - s0)
            if (seg, str(a), n) not in core.MISSING_WORDS:
                core.MISSING_WORDS.append((seg, str(a), n))
    if t is None:
        t = s0 + default * (s1 - s0)
    _CACHE[key] = t
    return t


# ---------------------------------------------------------------- text layout (Thai has no spaces: wrap on word tokens)
_wrapc = {}

def wrap(txt, size, maxw, weight=800):
    key = (txt, size, maxw, weight)
    if key in _wrapc:
        return _wrapc[key]
    f = F(size, weight)
    if f.getlength(txt) <= maxw:
        _wrapc[key] = [txt]
        return [txt]
    try:
        from pythainlp.tokenize import word_tokenize
        toks = word_tokenize(txt, engine='newmm', keep_whitespace=True)
    except Exception:
        toks = list(txt)
    lines, cur = [], ''
    for tk in toks:
        if tk.strip() and all(c in '?!.,…)"”%' for c in tk.strip()):  # never start a line with punctuation
            cur += tk
            continue
        if cur.strip() and f.getlength(cur + tk) > maxw:
            lines.append(cur.strip())
            cur = tk.lstrip()
        else:
            cur += tk
    if cur.strip():
        lines.append(cur.strip())
    _wrapc[key] = lines
    return lines


_blk = {}
_cmap = None
_SUBS = {'≈': '~', '×': 'x', '→': '>', '←': '<', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...', '–': '-', '—': '-'}


def clean(txt):
    """Drop characters the Kanit font cannot draw (emoji etc.) so they never render as empty boxes."""
    global _cmap
    if _cmap is None:
        try:
            import os
            from fontTools.ttLib import TTFont
            _cmap = set(TTFont(os.path.join(core.FD, 'Kanit-800.ttf'))['cmap'].getBestCmap())
        except Exception:
            _cmap = set()
    out = []
    for ch in str(txt):
        if _cmap and ord(ch) not in _cmap and not ch.isspace():
            sub = _SUBS.get(ch)
            if sub and all(ord(c) in _cmap for c in sub):
                out.append(sub)
            continue
        out.append(ch)
    return re.sub(r'\s{2,}', ' ', ''.join(out)).strip()


def text_img(txt, *a, **k):  # every template string goes through clean()
    return core.text_img(clean(txt) or ' ', *a, **k)

def tblock(txt, size, maxw, weight=800, fill=WHITE, stroke=0, sfill=INK, max_lines=3, lh=1.12, align='center'):
    """Wrapped, centred text as one RGBA image; shrinks the font until it fits in max_lines."""
    txt = clean(txt or '')
    key = (txt, size, maxw, weight, fill, stroke, sfill, max_lines, align)
    if key in _blk:
        return _blk[key]
    s = size
    lines = wrap(txt, s, maxw, weight)
    while len(lines) > max_lines and s > size * 0.55:
        s = int(s * 0.9)
        lines = wrap(txt, s, maxw, weight)
    ims = [text_img(l, s, weight, fill, stroke, sfill) for l in lines[:max_lines + 1]]
    step = int(s * lh)
    w = max(i.width for i in ims) if ims else 1
    h = step * (len(ims) - 1) + (ims[-1].height if ims else 1)
    out = Image.new('RGBA', (max(1, w), max(1, h)), (0, 0, 0, 0))
    for k, im in enumerate(ims):
        x = (w - im.width) // 2 if align == 'center' else 0
        out.alpha_composite(im, (x, k * step))
    _blk[key] = out
    return out


def col(name, default=YEL):
    if isinstance(name, (list, tuple)) and len(name) >= 3:
        return tuple(int(v) for v in name[:3])
    return COLORS.get(str(name or '').lower(), default)


def fmt_num(v, decimals=0):
    try:
        v = float(v)
    except Exception:
        return str(v)
    return f'{v:,.{int(decimals)}f}'


def card(w, h, fill=(255, 255, 255, 245), outline=INK + (255,), r=36, width=8):
    im = Image.new('RGBA', (int(w), int(h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, 'RGBA')
    d.rounded_rectangle((width // 2, width // 2, w - width // 2 - 1, h - width // 2 - 1), r, fill=fill, outline=outline, width=width)
    return im


def bob(t, k=0, amp=10):
    return math.sin(t * 2.4 + k * 1.3) * amp


# ---------------------------------------------------------------- background decor
def decor(d, t, seed):
    rnd = random.Random(seed)
    for i in range(14):
        x = rnd.uniform(0, W)
        y0 = rnd.uniform(0, H)
        r = rnd.uniform(18, 70)
        sp = rnd.uniform(12, 40)
        y = (y0 - t * sp) % (H + 200) - 100
        a = int(rnd.uniform(14, 34))
        if i % 3 == 0:
            d.ellipse((x - r, y - r, x + r, y + r), outline=(255, 255, 255, a), width=6)
        else:
            d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, a))


# ---------------------------------------------------------------- common overlays
def headline(img, t, seg, sp):
    h = sp.get('headline')
    y = 300
    if h:
        h = h if isinstance(h, dict) else {'text': h}
        th = at(seg, h.get('at'), 0.0)
        s = pop(t, th)
        if s > 0:
            im = tblock(h.get('text'), 88, 960, 800, col(h.get('color'), WHITE), 9, INK, 2)
            put(img, im, 540, y + im.height / 2 - 50, s)
            y += im.height + 10
        else:
            y += 100
    sb = sp.get('sub')
    if sb:
        sb = sb if isinstance(sb, dict) else {'text': sb}
        ts = at(seg, sb.get('at'), 0.15)
        s = pop(t, ts)
        if s > 0:
            im = tblock(sb.get('text'), 70, 940, 800, col(sb.get('color'), YEL), 8, INK, 2)
            put(img, im, 540, y + im.height / 2 - 30, s)


CAST = {}  # name -> look, from the episode spec ("cast")
BACKDROP = {}  # cast name -> prepared photo background (1.06x of the frame, for a slow drift), see photo_backdrop()


def photo_backdrop(data_url):
    """The background of a character's uploaded photo (the person was already erased in the browser), flattened into a
    simple poster-like backdrop by code: median-smoothed, reduced to a few colours, softened toward white so the cast and the
    text stay readable. Returns a (1145 x 2035) RGBA image or None."""
    import base64, io
    try:
        raw = base64.b64decode(str(data_url).split(',', 1)[1])
        im = Image.open(io.BytesIO(raw)).convert('RGB')
    except Exception:
        return None
    tw, th = int(W * 1.06), int(H * 1.06)
    k = max(tw / im.width, th / im.height)
    im = im.resize((max(tw, round(im.width * k)), max(th, round(im.height * k))), Image.LANCZOS)
    l, t = (im.width - tw) // 2, (im.height - th) // 2
    im = im.crop((l, t, l + tw, t + th))
    small = im.resize((tw // 4, th // 4), Image.LANCZOS).filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.GaussianBlur(1.2))
    small = small.quantize(colors=16, method=Image.MEDIANCUT, dither=Image.NONE).convert('RGB')
    flat = small.resize((tw, th), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2.2))
    soft = Image.blend(flat, Image.new('RGB', flat.size, (255, 250, 242)), 0.16)
    return soft.convert('RGBA')


def backdrop_for(sp):
    """The photo background to use for a scene: a scenario scene whose person has one, unless the script picked a set
    (the opening scene always uses it)."""
    if not BACKDROP or sp.get('type') != 'scenario':
        return None
    if sp.get('set') not in (None, '', 'photo') and sp.get('_i') != 0:
        return None
    for k in ('person', 'person2'):
        p = sp.get(k)
        if isinstance(p, dict) and p.get('who') in BACKDROP:
            return BACKDROP[p['who']]
    if not sp.get('person') and CAST:
        return BACKDROP.get(next(iter(CAST)))
    return None


def draw_backdrop(img, bg, t):
    ox = int((bg.width - W) / 2 + math.sin(t * 0.35) * (bg.width - W) * 0.45)
    oy = int((bg.height - H) / 2 + math.cos(t * 0.27) * (bg.height - H) * 0.45)
    img.alpha_composite(bg.crop((ox, oy, ox + W, oy + H)))
LOOK_KEYS = ('hairstyle', 'hair_color', 'skin', 'top', 'top_color', 'inner_color', 'bottom', 'bottom_color', 'glasses', 'accessories', 'accessory_color', 'shoes_color', 'frame_color', 'pattern', 'pattern_color')


def person_style(p):
    """Style for a person spec: a cast member ("who"), an inline look, a legacy outfit colour, else the episode's first
    cast member, else Tum."""
    who = p.get('who')
    if who and who in CAST:
        return look_style(CAST[who])
    if any(k in p for k in LOOK_KEYS):
        return look_style({k: p[k] for k in LOOK_KEYS if k in p})
    if p.get('outfit') and p['outfit'] != 'navy':
        return OUTFITS.get(p['outfit'], {})
    if CAST:
        return look_style(next(iter(CAST.values())))
    return {}


def name_tag(img, p, x, y, size=40):
    who = p.get('who') or (next(iter(CAST)) if CAST and not any(k in p for k in LOOK_KEYS) else None)
    if not who or p.get('show_name') is False:
        return
    tim = text_img(str(who)[:14], size, 800, INK, 0)
    tag = card(tim.width + 36, tim.height + 14, (255, 255, 255, 240), INK + (255,), 999, 5)
    tag.alpha_composite(tim, (18, 7))
    put(img, tag, x, y)


# ---------------------------------------------------------------- character motion (owner's rule: a character in EVERY frame,
# moving differently with the context of each scene)
ACTIONS = ('idle', 'wave', 'hop', 'jump', 'nod', 'sway', 'shake', 'dance', 'lean', 'peek', 'run', 'cheer')
MOOD_ACTION = {'happy': 'hop', 'shock': 'shake', 'think': 'sway', 'worried': 'shake'}
# default action per template when the script does not choose one (the cat and the person get different ones)
CAT_ACTION = {'hook': 'jump', 'number': 'lean', 'compare': 'nod', 'bars': 'sway', 'list': 'nod', 'quiz': 'sway', 'reveal': 'cheer', 'dots': 'peek',
              'timeline': 'run', 'truth': 'shake', 'scenario': 'hop', 'icons': 'dance', 'outro': 'dance', 'chat': 'peek', 'versus': 'lean', 'scale': 'hop'}
PERSON_ACTION = {'hook': 'peek', 'number': 'nod', 'compare': 'sway', 'bars': 'nod', 'list': 'lean', 'quiz': 'sway', 'reveal': 'jump', 'dots': 'nod',
                 'timeline': 'lean', 'truth': 'nod', 'scenario': 'sway', 'icons': 'hop', 'outro': 'cheer', 'chat': 'nod', 'versus': 'shake', 'scale': 'peek'}


def motion(name, t, t0, side=1):
    """Body motion for a character: -> (dx, dy, rot_degrees, squash, wave). `side` is +1 when it stands on the right, -1 on the left."""
    u = t - t0
    if u < 0 or not name or name == 'idle':
        return 0.0, 0.0, 0.0, 1.0, 0.0
    s, ab = math.sin, lambda v: abs(math.sin(v))
    if name == 'wave':
        return 0.0, -ab(u * 5) * 8, s(u * 3) * 3, 1.0, 1.0
    if name == 'hop':
        h = ab(u * 4.2)
        return 0.0, -h * 40, 0.0, 1.0 + 0.06 * h - 0.05 * (1 - h) ** 6, 0.0
    if name == 'jump':
        k = min(u / 0.8, 1.0)
        h = s(math.pi * k) if u < 0.8 else ab((u - 0.8) * 3.6) * 0.28
        return 0.0, -h * 150, 0.0, 1.0 + 0.1 * h, 0.0
    if name == 'nod':
        return 0.0, s(u * 7) * 14, s(u * 3.5) * 3, 1.0, 0.0
    if name == 'sway':
        return s(u * 2.2) * 16, 0.0, s(u * 2.2) * 8, 1.0, 0.0
    if name == 'shake':
        k = math.exp(-u * 0.9) * 0.8 + 0.2
        return s(u * 26) * 16 * k, 0.0, s(u * 26) * 4 * k, 1.0, 0.0
    if name == 'dance':
        return s(u * 2.5) * 34, -ab(u * 5) * 30, s(u * 5) * 11, 1.0, 1.0
    if name == 'lean':
        k = eo(min(u / 0.5, 1.0))
        return -side * 70 * k, s(u * 3) * 6, -side * 7 * k, 1.0, 0.0
    if name == 'peek':
        k = eo(min(u / 0.6, 1.0))
        return side * 300 * (1 - k), s(u * 3) * 8 * k, 0.0, 1.0, 0.0
    if name == 'run':
        return -side * (0.5 - 0.5 * math.cos(u * 0.9)) * 460, -ab(u * 6.5) * 22, -side * 5, 1.0, 0.0
    if name == 'cheer':
        return 0.0, -ab(u * 6) * 55, s(u * 6) * 6, 1.0, 1.0
    return 0.0, 0.0, 0.0, 1.0, 0.0


def _actor(spec, seg, t, kind, table, moods):
    """Resolve a character's mood and action for time t: an explicit "action" wins, then the mood (explicit or reacted), then the template default."""
    mood = spec.get('mood', 'normal')
    t_act = 0.0
    r = spec.get('react')
    if isinstance(r, dict) and t >= at(seg, r.get('at'), 0.5):
        mood = r.get('mood', mood)
        t_act = at(seg, r.get('at'), 0.5)
    mood = mood if mood in moods else 'normal'
    a = spec.get('action')
    if isinstance(a, str):
        a = {'name': a}
    if isinstance(a, dict) and a.get('name') in ACTIONS:
        return mood, a['name'], at(seg, a.get('at'), 0.0)
    if mood in MOOD_ACTION:
        return mood, MOOD_ACTION[mood], t_act
    return mood, table.get(kind, 'nod'), 0.0


def mascots(img, t, seg, sp, default_cat=True):
    talk = talk_amount(t)
    kind = sp.get('type')
    flip = bool(sp.get('_flip'))     # alternate the corners from scene to scene so the characters do not sit in the same spot every time
    p = sp.get('person')
    if not p and CAST and kind not in OWN_CAST:  # the cast is on screen in every scene, even when the script does not place them
        names = list(CAST)
        p = {'who': names[int(sp.get('_i', 0)) % len(names)]}
    if p:
        p = p if isinstance(p, dict) else {}
        mood, act, t0 = _actor(p, seg, t, kind, PERSON_ACTION, ('normal', 'happy', 'shock', 'think'))
        x = {'left': 190, 'right': 890, 'center': 540}.get(p.get('x', 'right' if flip else 'left'), 190)
        dx, dy, _, _, wv = motion(act, t, t0, 1 if x > 540 else -1)
        draw_person(img, x + dx, 1255 + dy, 150, t, style=person_style(p), pose='stand', mood=mood, wave=wv, talk=0.0,
                    glasses=p.get('glasses') is not False, hand_chin=mood == 'think', look=(0.3 if x < 540 else -0.3, -0.2))
        if p.get('show_name') is True:
            name_tag(img, p, x + dx, 1150 + dy, 34)
    c = sp.get('cat', {} if default_cat else None)
    if c is False:      # the owner's rule: a character in every frame; the narrator cat can no longer be switched off
        c = {}
    if c is not None:
        c = c if isinstance(c, dict) else {}
        mood, act, t0 = _actor(c, seg, t, kind, CAT_ACTION, ('normal', 'happy', 'shock', 'worried'))
        x = {'left': 180, 'right': 900, 'center': 540}.get(c.get('x', 'left' if flip else 'right'), 900)
        dx, dy, rot, sq, wv = motion(act, t, t0, 1 if x > 540 else -1)
        draw_cat(img, x + dx, 1300 + dy, 150, t, mood=mood, talk=talk, rot=rot, sq=sq, wave=wv,
                 look=(-0.4 if x > 540 else 0.4, -0.2), kind=c.get('kind', 'mint') if c.get('kind') in ('mint', 'peach', 'ghost', 'grey') else 'mint')


OUTFITS = {
    'navy': {}, 'red': {'jacket': (200, 60, 70), 'jacket_dark': (140, 36, 48)}, 'green': {'jacket': (40, 140, 100), 'jacket_dark': (24, 96, 66)},
    'purple': {'jacket': (110, 70, 190), 'jacket_dark': (74, 44, 134)}, 'orange': {'jacket': (236, 130, 40), 'jacket_dark': (176, 88, 22)},
    'grey': {'jacket': (110, 116, 130), 'jacket_dark': (74, 78, 90)},
}


def extras(img, d, t, seg, sp):
    st = sp.get('stamp')
    if isinstance(st, dict) and st.get('text'):
        ts = at(seg, st.get('at'), 0.6)
        dy = 440 if sp.get('type') == 'scenario' and not sp.get('headline') else 1130
        stamp(img, str(st['text'])[:18], st.get('x', 540 if dy == 440 else 600), st.get('y', dy), t, ts,
              col=col(st.get('color'), (235, 60, 80)) if st.get('color') else (235, 60, 80), size=int(st.get('size', 96)), rot=-8)
    cf = sp.get('confetti')
    if cf:
        tc = at(seg, cf.get('at') if isinstance(cf, dict) else None, 0.0)
        confetti(d, t, tc, 540, 900, 70)
    nt = sp.get('note')
    if nt:
        nt = nt if isinstance(nt, dict) else {'text': nt}
        tn = at(seg, nt.get('at'), 0.1)
        if t >= tn:
            im = tblock(nt.get('text'), 34, 700, 600, WHITE, 0, INK, 2)
            bg = card(im.width + 44, im.height + 24, (20, 14, 40, 170), None, 22, 0)
            bg.alpha_composite(im, (22, 12))
            put(img, bg, 540, 1385 - bg.height / 2, 1, fade(t, tn))


# ---------------------------------------------------------------- templates
def T_hook(img, d, t, seg, sp):
    rays(d, 540, 900, t, (255, 255, 255, 22))
    lines = sp.get('lines') or ([{'text': sp['headline']['text'] if isinstance(sp.get('headline'), dict) else sp.get('headline', '')}] if sp.get('headline') else [])
    y = 480
    for i, ln in enumerate(lines[:3]):
        ln = ln if isinstance(ln, dict) else {'text': ln}
        tl = at(seg, ln.get('at'), 0.0 if i == 0 else 0.3 * i)
        size = 118 if i == 0 else 100
        fill = col(ln.get('color'), WHITE if i == 0 else YEL)
        im = tblock(ln.get('text'), size, 980, 900, fill, 12, INK, 2)
        if t >= tl:
            sh = math.sin(t * 34) * 7 * clamp(1 - (t - tl) / 0.5)
            put(img, im, 540 + sh, y + im.height / 2, pop(t, tl), 1, -3 if i % 2 == 0 else 2)
        y += im.height + 30
    ic = sp.get('icon')
    if ic:
        ti = at(seg, sp.get('icon_at'), 0.35)
        put(img, icon(ic, 300), 540, max(y + 190, 1000) + bob(t, 0, 14), pop(t, ti), 1, math.sin(t * 2) * 6)


def T_number(img, d, t, seg, sp):
    ta = at(seg, sp.get('at'), 0.1)
    dur = float(sp.get('duration', 1.6))
    u = eo((t - ta) / dur) if t >= ta else 0
    val = float(sp.get('value', 0) or 0)
    txt = f"{sp.get('prefix', '')}{fmt_num(val * u, sp.get('decimals', 0))}{sp.get('suffix', '')}"
    final = f"{sp.get('prefix', '')}{fmt_num(val, sp.get('decimals', 0))}{sp.get('suffix', '')}"
    size = 150 if len(final) <= 9 else (118 if len(final) <= 13 else 92)
    cy = 820
    ic = sp.get('icon')
    if ic:
        put(img, icon(ic, 220), 540, 600 + bob(t, 1, 10), pop(t, ta - 0.2))
        cy = 880
    bg = card(960, 300)
    s = pop(t, ta - 0.1)
    put(img, bg, 540, cy, s)
    if s > 0.5:
        shake = 1 + 0.03 * (0 < u < 1) * math.sin(t * 30)
        put(img, text_img(txt, size, 900, (40, 60, 160), 0), 540, cy - 20, shake)
        lab = sp.get('label')
        if lab:
            lab = lab if isinstance(lab, dict) else {'text': lab}
            tl = at(seg, lab.get('at'), 0.4)
            if t >= tl:
                put(img, tblock(lab.get('text'), 50, 880, 800, (90, 80, 120), 0, INK, 1), 540, cy + 95, pop(t, tl))
    if u >= 1 and sp.get('burst', True):
        confetti(d, t, ta + dur, 540, cy - 40, 40)


def T_compare(img, d, t, seg, sp):
    items = (sp.get('items') or [])[:3]
    if not items:
        return
    n = len(items)
    vals = [abs(float(it.get('value', 0) or 0)) for it in items]
    mx = max(vals) or 1
    xs = [540] if n == 1 else ([310, 770] if n == 2 else [220, 540, 860])
    bw = 300 if n <= 2 else 230
    base, hmax = 1150, 400
    hl = sp.get('highlight')
    thl = at(seg, sp.get('highlight_at'), 0.85) if hl is not None else None
    for i, it in enumerate(items):
        ti = at(seg, it.get('at'), 0.15 + 0.3 * i)
        g = eo((t - ti) / 0.9) if t >= ti else 0
        hgt = max(8, hmax * vals[i] / mx * g)
        x = xs[i]
        c = col(it.get('color'), ACCENTS[i % len(ACCENTS)])
        win = hl is not None and int(hl) == i and t >= thl
        if t >= ti - 0.05:
            d.rounded_rectangle((x - bw / 2, base - hgt, x + bw / 2, base), 26, fill=c + (255,), outline=(255, 225, 60, 255) if win else INK + (255,), width=12 if win else 8)
            disp = it.get('display') or fmt_num(it.get('value', 0))
            put(img, tblock(disp, 80 if n <= 2 else 62, bw + 60, 900, WHITE, 9, INK, 2), x, base - hgt - 62, pop(t, ti + 0.5))
            if it.get('icon'):
                put(img, icon(it['icon'], 170), x, base - hgt - 205 + bob(t, i, 6), pop(t, ti + 0.3))
            put(img, tblock(it.get('label', ''), 58, bw + 80, 800, WHITE, 7, INK, 2), x, base + 62, pop(t, ti))
        if win:
            sc = pop(t, thl)
            put(img, icon('star', 110), x + bw / 2 - 10, base - hgt - 10, sc, 1, math.sin(t * 3) * 10)
    d.line((60, base, 1020, base), fill=(255, 255, 255, 200), width=6)


def T_bars(img, d, t, seg, sp):
    items = (sp.get('items') or [])[:6]
    if not items:
        return
    n = len(items)
    vals = [abs(float(it.get('value', 0) or 0)) for it in items]
    mx = max(vals) or 1
    step = min(175, 720 / n)
    top = 540 + max(0, (720 - step * n) / 2) * 0.6
    x0, wmax = 400, 500
    hl = sp.get('highlight')
    for i, it in enumerate(items):
        ti = at(seg, it.get('at'), 0.1 + 0.6 * i / max(1, n))
        y = top + i * step + step / 2
        if t < ti - 0.05:
            continue
        g = eo((t - ti) / 0.8)
        c = col(it.get('color'), ACCENTS[i % len(ACCENTS)])
        lab = tblock(it.get('label', ''), 56, 330, 800, WHITE, 7, INK, 2)
        put(img, lab, 375 - lab.width / 2, y, pop(t, ti))
        bwid = max(14, wmax * vals[i] / mx * g)
        win = hl is not None and int(hl) == i
        d.rounded_rectangle((x0, y - step * 0.32, x0 + bwid, y + step * 0.32), 18, fill=c + (255,),
                            outline=(255, 225, 60, 255) if win else INK + (255,), width=10 if win else 6)
        disp = text_img(str(it.get('display') or fmt_num(it.get('value', 0))), 56, 900, WHITE, 8, INK)
        put(img, disp, min(x0 + bwid + 20 + disp.width / 2, 1060 - disp.width / 2), y, pop(t, ti + 0.4))


def _mark(d, img, kind, k, x, y, c):
    if kind == 'check':
        d.ellipse((x - 42, y - 42, x + 42, y + 42), fill=(60, 190, 120, 255), outline=INK + (255,), width=6)
        check(d, x, y, 46, True)
    elif kind == 'cross':
        d.ellipse((x - 42, y - 42, x + 42, y + 42), fill=(255, 225, 228, 255), outline=INK + (255,), width=6)
        check(d, x, y, 46, False)
    else:
        d.ellipse((x - 42, y - 42, x + 42, y + 42), fill=c + (255,), outline=INK + (255,), width=6)
        put(img, text_img(str(k + 1), 54, 900, WHITE, 0), x, y)


def T_list(img, d, t, seg, sp):
    items = (sp.get('items') or [])[:5]
    n = len(items)
    if not n:
        return
    step = min(205, 720 / n)
    top = 540 + max(0, (720 - step * n) / 2) * 0.6
    mark = sp.get('mark', 'number')
    for i, it in enumerate(items):
        it = it if isinstance(it, dict) else {'text': it}
        ti = at(seg, it.get('at'), 0.08 + 0.7 * i / n)
        if t < ti:
            continue
        u = eo((t - ti) / 0.35)
        y = top + i * step + step / 2
        x = 540 + (1 - u) * 700
        cw, ch = 980, step - 26
        lay = card(cw, ch, (255, 255, 255, 240), INK + (255,), 30, 6)
        dd = ImageDraw.Draw(lay, 'RGBA')
        c = ACCENTS[i % len(ACCENTS)]
        if it.get('icon') and mark == 'icon':
            ic = icon(it['icon'], int(ch - 26))
            lay.alpha_composite(ic, (20, (ch - ic.height) // 2))
        else:
            _mark(dd, lay, it.get('mark', mark), i, 64, ch / 2, c)
        tx = tblock(it.get('text', ''), 64, cw - 200, 800, INK, 0, INK, 2, align='left')
        lay.alpha_composite(tx, (130, int((ch - tx.height) / 2)))
        if it.get('icon') and mark != 'icon':
            ic = icon(it['icon'], int(ch - 34))
            lay.alpha_composite(ic, (cw - ic.width - 18, (ch - ic.height) // 2))
        put(img, lay, x, y, 1)


def _option(img, y, letter, label, color, s, dim=1.0, hl=None):
    if s <= 0:
        return
    lay = Image.new('RGBA', (880, 150), (0, 0, 0, 0))
    dd = ImageDraw.Draw(lay, 'RGBA')
    edge = {None: INK, 'good': (60, 200, 120), 'bad': (235, 70, 90)}[hl]
    dd.rounded_rectangle((4, 4, 876, 146), 40, fill=(255, 255, 255, 245), outline=edge + (255,), width=14 if hl else 8)
    dd.ellipse((26, 22, 132, 128), fill=color + (255,))
    li = text_img(str(letter)[:2], 70, 900, WHITE, 0)
    lay.alpha_composite(li, (79 - li.width // 2, 75 - li.height // 2))
    ti = tblock(label, 64, 690, 900, INK, 0, INK, 1, align='left')
    lay.alpha_composite(ti, (165, 75 - ti.height // 2))
    if hl == 'good':
        check(dd, 820, 75, 50, True)
    put(img, lay, 540, y, s, dim)


def T_quiz(img, d, t, seg, sp):
    rays(d, 540, 900, t, (255, 255, 255, 20))
    q = sp.get('question') or {}
    q = q if isinstance(q, dict) else {'text': q}
    opts = (sp.get('options') or [])[:4]
    n = max(1, len(opts))
    tq = at(seg, q.get('at'), 0.05)
    if q.get('text') and t >= tq:
        im = tblock(q.get('text'), 64, 900, 900, INK, 0, INK, 3)
        bg = card(980, im.height + 70)
        bg.alpha_composite(im, ((980 - im.width) // 2, 35))
        put(img, bg, 540, 560 + bg.height / 2 - 40, pop(t, tq))
    cd = sp.get('countdown') or []
    tcd = [at(seg, c, 0.8 + 0.06 * k) for k, c in enumerate(cd[:3])]
    dim = 0.4 if tcd and t >= tcd[0] else 1.0
    y0 = 860 if n <= 3 else 820
    for i, o in enumerate(opts):
        o = o if isinstance(o, dict) else {'text': o}
        to = at(seg, o.get('at'), 0.4 + 0.12 * i)
        _option(img, y0 + i * 165, o.get('letter', 'ABCD'[i]), o.get('text', ''), ACCENTS[i % len(ACCENTS)], pop(t, to), dim)
    for k, tt in enumerate(tcd):
        nxt = tcd[k + 1] if k + 1 < len(tcd) else tt + 0.7
        if tt <= t < nxt:
            sc = eob((t - tt) / 0.22)
            d.ellipse((540 - 190, 1000 - 190, 540 + 190, 1000 + 190), fill=(255, 255, 255, 245), outline=(255, 60, 90, 255), width=16)
            put(img, text_img(str(len(tcd) - k), 260, 900, (255, 60, 90), 0), 540, 990, sc)


def T_reveal(img, d, t, seg, sp):
    rays(d, 540, 900, t, (255, 255, 255, 26))
    opts = (sp.get('options') or [])[:4]
    good = int(sp.get('correct', 0) or 0)
    tr = at(seg, sp.get('at'), 0.05)
    big = sp.get('big')
    y0 = 860 if len(opts) <= 3 else 820
    for i, o in enumerate(opts):
        o = o if isinstance(o, dict) else {'text': o}
        revealed = t >= tr
        hl = 'good' if (revealed and i == good) else None
        dim = 1.0 if (not revealed or i == good) else 0.35
        sc = 1.0 + (0.06 * math.sin(clamp((t - tr) / 0.5) * math.pi) if hl else 0)
        _option(img, y0 + i * 165, o.get('letter', 'ABCD'[i]), o.get('text', ''), ACCENTS[i % len(ACCENTS)], sc, dim, hl)
    if big:
        big = big if isinstance(big, dict) else {'text': big}
        tb = at(seg, big.get('at'), 0.1)
        if t >= tb:
            put(img, tblock(big.get('text'), 150, 980, 900, YEL, 14, INK, 1), 540, 610, pop(t, tb), 1, -4)
    confetti(d, t, tr, 540, 820, 80)


def T_dots(img, d, t, seg, sp):
    total = int(clamp(float(sp.get('total', 100) or 100), 4, 400))
    k = int(clamp(float(sp.get('highlight', 10) or 0), 0, total))
    cols = min(20, math.ceil(math.sqrt(total)))
    rows = math.ceil(total / cols)
    sp_ = min(880 / cols, 640 / rows)
    x0 = 540 - sp_ * (cols - 1) / 2
    y0 = 560 + (640 - sp_ * (rows - 1)) / 2
    ta = at(seg, sp.get('at'), 0.1)
    th = at(seg, sp.get('highlight_at'), 0.45)
    g = clamp((t - ta) / 0.8)
    gh = clamp((t - th) / 0.9)
    r = sp_ * 0.36
    hc = col(sp.get('color'), YEL)
    person = sp.get('unit', 'person') == 'person'
    for i in range(int(total * g)):
        rr, cc = divmod(i, cols)
        x, y = x0 + cc * sp_, y0 + rr * sp_
        lit = i < int(k * gh)
        c = hc + (255,) if lit else (255, 255, 255, 120)
        if person:
            d.ellipse((x - r * 0.5, y - r * 0.95, x + r * 0.5, y - r * 0.05), fill=c)
            d.rounded_rectangle((x - r * 0.75, y + r * 0.05, x + r * 0.75, y + r * 1.0), int(r * 0.45), fill=c)
        else:
            d.ellipse((x - r, y - r, x + r, y + r), fill=c)
    lab = sp.get('label')
    if lab:
        lab = lab if isinstance(lab, dict) else {'text': lab}
        tl = at(seg, lab.get('at'), 0.6)
        if t >= tl:
            im = tblock(lab.get('text'), 84, 940, 900, hc, 10, INK, 2)
            put(img, im, 540, min(1210, y0 + sp_ * rows + 30), pop(t, tl))


def T_timeline(img, d, t, seg, sp):
    items = (sp.get('items') or [])[:5]
    n = len(items)
    if not n:
        return
    top, bot = 580, 1200
    step = (bot - top) / max(1, n - 1) if n > 1 else 0
    t0 = at(seg, items[0].get('at') if isinstance(items[0], dict) else None, 0.05)
    tl = at(seg, items[-1].get('at') if isinstance(items[-1], dict) else None, 0.8)
    g = clamp((t - t0) / max(0.4, tl - t0 + 0.4))
    d.line((230, top, 230, top + (bot - top) * g), fill=(255, 255, 255, 230), width=14)
    for i, it in enumerate(items):
        it = it if isinstance(it, dict) else {'text': it}
        ti = at(seg, it.get('at'), 0.05 + 0.8 * i / max(1, n))
        if t < ti:
            continue
        y = top + i * step if n > 1 else 880
        s = pop(t, ti)
        c = ACCENTS[i % len(ACCENTS)]
        yr = text_img(str(it.get('year', '')), 60, 900, WHITE, 0)
        pill = card(max(190, yr.width + 50), 100, c + (255,), INK + (255,), 50, 7)
        pill.alpha_composite(yr, ((pill.width - yr.width) // 2, (100 - yr.height) // 2))
        put(img, pill, 230, y, s)
        tx = tblock(it.get('text', ''), 64, 640, 800, WHITE, 8, INK, 2, align='left')
        put(img, tx, 350 + tx.width / 2 + (1 - eo((t - ti) / 0.3)) * 200, y, 1, fade(t, ti))


def T_truth(img, d, t, seg, sp):
    st = sp.get('statement') or {}
    st = st if isinstance(st, dict) else {'text': st}
    ts = at(seg, st.get('at'), 0.02)
    if t >= ts:
        im = tblock('“' + str(st.get('text', '')) + '”', 74, 860, 800, INK, 0, INK, 3)
        bg = card(960, im.height + 90)
        bg.alpha_composite(im, ((960 - im.width) // 2, 45))
        put(img, bg, 540, 620 + bg.height / 2 - 40, pop(t, ts))
        ybot = 620 + bg.height - 40
    else:
        ybot = 860
    ok = bool(sp.get('verdict', False))
    tv = at(seg, sp.get('verdict_at'), 0.35)
    if t >= tv:
        stamp(img, sp.get('verdict_text') or ('จริง!' if ok else 'ไม่จริง!'), 540, ybot + 130, t, tv, col=(40, 170, 100) if ok else (235, 60, 80), size=120, rot=-10)
    ex = sp.get('explain')
    if ex:
        ex = ex if isinstance(ex, dict) else {'text': ex}
        te = at(seg, ex.get('at'), 0.55)
        if t >= te:
            im = tblock(ex.get('text'), 64, 900, 800, WHITE, 8, INK, 3)
            put(img, im, 540, ybot + 270 + im.height / 2, pop(t, te))


def T_scenario(img, d, t, seg, sp):
    talk = talk_amount(t)
    p = sp.get('person', {}) or {}
    p = p if isinstance(p, dict) else {}
    if not p and CAST:
        p = {'who': next(iter(CAST))}
    mood, act, t0 = _actor(p, seg, t, 'scenario', PERSON_ACTION, ('normal', 'happy', 'shock', 'think'))
    p2 = sp.get('person2')
    px, ps = (300, 230) if isinstance(p2, dict) else (380, 250)
    dx, dy, _, _, wv = motion(act, t, t0, -1)
    draw_person(img, px + dx, 860 + dy, ps, t, style=person_style(p), pose='stand', mood=mood, wave=wv, talk=0.0,
                glasses=p.get('glasses') is not False, hand_chin=mood == 'think', look=(0.4, -0.2))
    name_tag(img, p, px + dx, 860 + dy + ps * 1.85)
    if isinstance(p2, dict):  # a second character, e.g. "แบงค์ vs ตั้ม"
        m2, act2, t02 = _actor(p2, seg, t, 'versus', PERSON_ACTION, ('normal', 'happy', 'shock', 'think'))
        dx2, dy2, _, _, wv2 = motion(act2, t, t02, 1)
        draw_person(img, 780 + dx2, 860 + dy2, 230, t, style=person_style(p2), pose='stand', mood=m2, wave=wv2,
                    glasses=p2.get('glasses') is not False, hand_chin=m2 == 'think', look=(-0.4, -0.2))
        name_tag(img, p2, 780 + dx2, 860 + dy2 + 230 * 1.85)
    c = sp.get('cat', {}) or {}
    c = c if isinstance(c, dict) else {}
    cm, cact, ct0 = _actor(c, seg, t, 'scenario', CAT_ACTION, ('normal', 'happy', 'shock', 'worried'))
    cdx, cdy, crot, csq, cwv = motion(cact, t, ct0, 1)
    if isinstance(p2, dict):
        draw_cat(img, 950 + cdx, 1330 + cdy, 110, t, mood=cm, talk=talk, rot=crot, sq=csq, wave=cwv, look=(-0.5, -0.2))
    else:
        draw_cat(img, 830 + cdx, 1170 + cdy, 170, t, mood=cm, talk=talk, rot=crot, sq=csq, wave=cwv, look=(-0.5, -0.2))
    b = sp.get('bubble')
    if b:
        b = b if isinstance(b, dict) else {'text': b}
        tb = at(seg, b.get('at'), 0.1)
        if t >= tb:
            two = isinstance(p2, dict)
            im = tblock(b.get('text'), 54 if two else 58, 380 if two else 620, 800, INK, 0, INK, 3)
            lay = card(im.width + 70, im.height + 60, (255, 255, 255, 250), INK + (255,), 40, 7)
            lay.alpha_composite(im, (35, 30))
            put(img, lay, 300 if two else 680, 560 + lay.height / 2 - 40, pop(t, tb))
    b2 = sp.get('bubble2')
    if b2 and isinstance(p2, dict):
        b2 = b2 if isinstance(b2, dict) else {'text': b2}
        tb2 = at(seg, b2.get('at'), 0.5)
        if t >= tb2:
            im = tblock(b2.get('text'), 54, 380, 800, INK, 0, INK, 3)
            lay = card(im.width + 70, im.height + 60, (255, 250, 230, 250), INK + (255,), 40, 7)
            lay.alpha_composite(im, (35, 30))
            put(img, lay, 790, 560 + lay.height / 2 - 40, pop(t, tb2))
    ic = sp.get('icon')
    if ic:
        ti = at(seg, sp.get('icon_at'), 0.3)
        if isinstance(p2, dict):
            put(img, icon(ic, 150), 540, 1180 + bob(t, 2, 10), pop(t, ti), 1, math.sin(t * 2.2) * 8)
        else:
            put(img, icon(ic, 200), 820, 900 + bob(t, 2, 12), pop(t, ti), 1, math.sin(t * 2.2) * 8)


def T_icons(img, d, t, seg, sp):
    items = (sp.get('items') or [])[:6]
    n = len(items)
    if not n:
        return
    cols = 2 if n in (2, 4) else 3
    rows = math.ceil(n / cols)
    tw = 310 if cols == 3 else 420
    th = 330 if cols == 3 else 340
    gx, gy = 330 if cols == 3 else 450, 360
    y0 = 515 + (2 - rows) * 170 + th / 2
    for i, it in enumerate(items):
        it = it if isinstance(it, dict) else {'label': it}
        rr, cc = divmod(i, cols)
        cnt = min(cols, n - rr * cols)
        x = 540 + (cc - (cnt - 1) / 2) * gx
        y = y0 + rr * gy
        ti = at(seg, it.get('at'), 0.08 + 0.7 * i / n)
        s = pop(t, ti)
        if s <= 0:
            continue
        lay = card(tw, th, (255, 255, 255, 235), INK + (255,), 36, 6)
        isz = 190 if cols == 3 else 200
        ic = icon(it.get('icon', 'star'), isz)
        lay.alpha_composite(ic, ((tw - isz) // 2, 20))
        lb = tblock(it.get('label', ''), 52, tw - 30, 800, INK, 0, INK, 2)
        lay.alpha_composite(lb, ((tw - lb.width) // 2, isz + 22 + (th - isz - 30 - lb.height) // 2))
        put(img, lay, x, y + bob(t, i, 5), s)


def T_outro(img, d, t, seg, sp):
    t0 = SEG[seg]['s']
    rnd = random.Random(4)
    for i in range(16):
        ph = rnd.uniform(0, 3)
        x = rnd.uniform(80, 1000)
        u = ((t - t0) * 0.35 + ph / 3) % 1.0
        y = 1300 - u * 900
        heart(d, x, y, 22 + 10 * rnd.random(), (255, 95, 130, int(200 * (1 - u))))
    lines = sp.get('lines') or []
    y = 480
    for i, ln in enumerate(lines[:3]):
        ln = ln if isinstance(ln, dict) else {'text': ln}
        tl = at(seg, ln.get('at'), 0.1 + 0.25 * i)
        im = tblock(ln.get('text'), 92 if i == 0 else 74, 980, 900, WHITE if i == 0 else YEL, 10, INK, 2)
        if t >= tl:
            put(img, im, 540, y + im.height / 2, pop(t, tl))
        y += im.height + 24
    tc = at(seg, sp.get('icon_at'), 0.3)
    comment_icon(d, 540, max(y + 200, 1000) + bob(t, 0, 12), 2.3 * pop(t, tc) if t >= tc else 0.01)


def T_chat(img, d, t, seg, sp):
    """Phone chat: messages pop in as they are spoken, with a typing indicator before each."""
    msgs = (sp.get('messages') or [])[:6]
    x0, y0, pw, ph = 150, 500, 780, 800
    d.rounded_rectangle((x0 - 14, y0 - 14, x0 + pw + 14, y0 + ph + 14), 70, fill=(28, 28, 36, 255))
    d.rounded_rectangle((x0, y0, x0 + pw, y0 + ph), 58, fill=(236, 240, 246, 255))
    d.rounded_rectangle((x0, y0, x0 + pw, y0 + 110), 58, fill=(255, 255, 255, 255))
    d.rectangle((x0, y0 + 60, x0 + pw, y0 + 110), fill=(255, 255, 255, 255))
    title = sp.get('title') or 'แชท'
    put(img, tblock(title, 44, pw - 140, 800, INK, 0, INK, 1), x0 + pw / 2, y0 + 70)
    d.rounded_rectangle((x0 + pw / 2 - 70, y0 + 12, x0 + pw / 2 + 70, y0 + 30), 9, fill=(28, 28, 36, 255))
    y = y0 + 140
    for i, m in enumerate(msgs):
        m = m if isinstance(m, dict) else {'text': m}
        tm = at(seg, m.get('at'), 0.1 + 0.8 * i / max(1, len(msgs)))
        right = m.get('from', 'left' if i % 2 == 0 else 'right') == 'right'
        if t < tm - 0.6:
            break
        if t < tm:  # typing dots
            bx = x0 + pw - 150 if right else x0 + 30
            d.rounded_rectangle((bx, y, bx + 120, y + 64), 32, fill=(210, 216, 226, 255))
            for k in range(3):
                a = 0.5 + 0.5 * math.sin(t * 9 - k)
                d.ellipse((bx + 26 + k * 28 - 8, y + 32 - 8 - 6 * a, bx + 26 + k * 28 + 8, y + 32 + 8 - 6 * a), fill=(120, 126, 140, 255))
            break
        im = tblock(m.get('text', ''), 50, 520, 600, WHITE if right else INK, 0, INK, 3, align='left')
        bw_, bh_ = im.width + 48, im.height + 34
        lay = card(bw_, bh_, ((60, 150, 255, 255) if right else (255, 255, 255, 255)), None, 30, 0)
        lay.alpha_composite(im, (24, 17))
        bx = x0 + pw - 24 - bw_ if right else x0 + 24
        if m.get('name') and not right:
            nm = text_img(clean(m['name'])[:16], 32, 600, (110, 116, 130), 0)
            put(img, nm, bx + 10 + nm.width / 2, y + 4)
            y += 38
        put(img, lay, bx + bw_ / 2, y + bh_ / 2, pop(t, tm, 0.25))
        y += bh_ + 18
        if y > y0 + ph - 80:
            break


def T_versus(img, d, t, seg, sp):
    """Two cards face off with a VS badge; optional winner highlight."""
    items = (sp.get('items') or [])[:2]
    if len(items) < 2:
        return
    tw_ = at(seg, sp.get('winner_at'), 0.85) if sp.get('winner') is not None else None
    for i, it in enumerate(items):
        it = it if isinstance(it, dict) else {'label': it}
        ti = at(seg, it.get('at'), 0.05 + 0.35 * i)
        if t < ti:
            continue
        u = eo((t - ti) / 0.35)
        cx = 290 if i == 0 else 790
        cx += (1 - u) * (-500 if i == 0 else 500)
        win = tw_ is not None and t >= tw_ and int(sp['winner']) == i
        lose = tw_ is not None and t >= tw_ and int(sp['winner']) != i
        c = col(it.get('color'), ACCENTS[0] if i == 0 else ACCENTS[1])
        cw, ch = 440, 640
        lay = card(cw, ch, c + (255,), (255, 225, 60, 255) if win else INK + (255,), 40, 14 if win else 8)
        lb = tblock(it.get('label', ''), 60, cw - 50, 900, WHITE, 8, INK, 2)
        lay.alpha_composite(lb, ((cw - lb.width) // 2, 30))
        yy = 40 + lb.height + 20
        if it.get('who') or it.get('look'):
            pl = Image.new('RGBA', (cw, 360), (0, 0, 0, 0))
            draw_person(pl, cw / 2, 100, 150, t, style=person_style(it if it.get('who') else (it.get('look') or {})), mood='happy' if win else ('shock' if lose else 'normal'))
            lay.alpha_composite(pl.crop((0, 0, cw, 345)), (0, yy))
            yy += 345
        elif it.get('icon'):
            ic = icon(it['icon'], 200)
            lay.alpha_composite(ic, ((cw - 200) // 2, yy))
            yy += 220
        for ln in (it.get('lines') or [])[:3]:
            tx = tblock(ln, 40, cw - 50, 800, WHITE, 6, INK, 2)
            if yy + tx.height < ch - 10:
                lay.alpha_composite(tx, ((cw - tx.width) // 2, yy))
            yy += tx.height + 10
        put(img, lay, cx, 900, 1.04 if win else 1.0, 0.55 if lose else 1.0)
    tv = at(seg, items[1].get('at') if isinstance(items[1], dict) else None, 0.4)
    if t >= tv:
        s = pop(t, tv)
        d.ellipse((540 - 90 * s, 900 - 90 * s, 540 + 90 * s, 900 + 90 * s), fill=(255, 225, 60, 255), outline=INK + (255,), width=10)
        put(img, text_img('VS', 84, 900, INK, 0), 540, 896, s, 1, math.sin(t * 6) * 4)
    if tw_ is not None and t >= tw_:
        confetti(d, t, tw_, 290 if int(sp['winner']) == 0 else 790, 700, 50)


def T_scale(img, d, t, seg, sp):
    """"That is as much as N <things>": an icon repeated N times, counted in as it is spoken."""
    n = int(clamp(float(sp.get('count', 10) or 10), 1, 60))
    ic = sp.get('icon', 'star')
    ta = at(seg, sp.get('at'), 0.15)
    g = clamp((t - ta) / max(0.6, min(2.2, n * 0.06)))
    cols = 1 if n == 1 else min(8, math.ceil(math.sqrt(n * 1.4)))
    rows = math.ceil(n / cols)
    sz = int(min(300, 820 / cols, 560 / rows))
    x0 = 540 - sz * (cols - 1) / 2
    y0 = 560 + sz / 2 + (560 - sz * rows) / 2
    im = icon(ic, max(24, int(sz * 0.88)))
    shown = int(n * g + (1 if t >= ta else 0))
    for i in range(min(n, shown)):
        r_, c_ = divmod(i, cols)
        put(img, im, x0 + c_ * sz, y0 + r_ * sz, 1.0 if i < shown - 1 else pop(t, ta + (i / max(1, n)) * max(0.6, min(2.2, n * 0.06)), 0.2))
    if t >= ta:
        put(img, text_img(f"× {n}", 70, 900, YEL, 9, INK), 900, y0 - sz / 2 - 30, pop(t, ta))
    lab = sp.get('label')
    if lab:
        lab = lab if isinstance(lab, dict) else {'text': lab}
        tl = at(seg, lab.get('at'), 0.6)
        if t >= tl:
            put(img, tblock(lab.get('text'), 70, 940, 900, WHITE, 9, INK, 2), 540, min(1220, y0 + sz * rows - sz / 2 + 70), pop(t, tl))


TEMPLATES = {
    'hook': T_hook, 'number': T_number, 'compare': T_compare, 'bars': T_bars, 'list': T_list, 'quiz': T_quiz, 'reveal': T_reveal,
    'dots': T_dots, 'timeline': T_timeline, 'truth': T_truth, 'scenario': T_scenario, 'icons': T_icons, 'outro': T_outro, 'chat': T_chat, 'versus': T_versus, 'scale': T_scale,
}
# templates that place their own big title / characters
OWN_TITLE = {'hook', 'outro'}
OWN_CAST = {'scenario'}


def _scene(seg, sp, seed):
    fn = TEMPLATES.get(sp.get('type'), T_scenario)
    kind = sp.get('type')

    def draw(img, d, t):
        # Pillow overwrites (does not blend) translucent fills on RGBA images; force blending for this frame
        d = ImageDraw.Draw(img, 'RGBA')
        try:
            d.draw = Image.core.draw(img.im, 1)
        except Exception:
            pass
        photo = backdrop_for(sp)
        if photo is not None:
            draw_backdrop(img, photo, t)
            has_set = True
        else:
            has_set = bool(sp.get('set')) and draw_set(sp.get('set'), img, d, t)
        if not has_set:
            decor(d, t, seed)
        try:
            fn(img, d, t, seg, sp)
            if kind not in OWN_CAST:
                mascots(img, t, seg, sp, default_cat=kind not in ('outro',) or True)
            if kind not in OWN_TITLE:
                headline(img, t, seg, sp)
            extras(img, d, t, seg, sp)
        except Exception as e:  # never kill the render over one bad spec: show a plain card and report it
            if seg not in [x[0] for x in ERRORS]:
                ERRORS.append((seg, repr(e)))
                traceback.print_exc(file=sys.stderr)
            title = (sp.get('headline') or {}).get('text') if isinstance(sp.get('headline'), dict) else sp.get('headline')
            put(img, tblock(title or _TEXT.get(seg, '')[:40], 80, 940, 800, WHITE, 8, INK, 3), 540, 760, 1)
            draw_cat(img, 540, 1150, 220, t, mood='normal', talk=talk_amount(t))
    return draw


def build_scenes(spec):
    """spec: {"scenes": [{"seg", "type", "bg", ...}], "text": {seg: narration}} -> SCENES for engine.render."""
    _TEXT.update(spec.get('text') or {})
    cast = spec.get('cast') or {}
    if isinstance(cast, list):
        cast = {str(c.get('name')): c for c in cast if isinstance(c, dict) and c.get('name')}
    CAST.clear()
    CAST.update({k: v for k, v in cast.items() if isinstance(v, dict)})
    BACKDROP.clear()
    for k, v in CAST.items():
        if v.get('backdrop'):
            bd = photo_backdrop(v['backdrop'])
            if bd is not None:
                BACKDROP[k] = bd
    out = {}
    for i, sp in enumerate(spec.get('scenes') or []):
        seg = sp.get('seg')
        if not seg:
            continue
        pal = PALETTES.get(sp.get('bg')) or PALETTES[PAL_ORDER[i % len(PAL_ORDER)]]
        out[seg] = (_scene(seg, dict(sp, _flip=bool(i % 2), _i=i), i + 3), pal)
    for i, sid in enumerate(core.ORDER):
        if sid not in out:  # a segment the spec forgot still gets a decent scene
            out[sid] = (_scene(sid, {'type': 'scenario', 'bubble': {'text': _TEXT.get(sid, '')[:60]}}, 50 + i), PALETTES[PAL_ORDER[i % len(PAL_ORDER)]])
    return out
