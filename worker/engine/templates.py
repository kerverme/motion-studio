"""Data-driven scene templates for generated episodes.

A generated episode describes every narration segment as a small JSON spec (see TEMPLATE_DOC in the API's generator);
build_scenes(spec) turns it into the SCENES mapping engine.render expects. Everything is drawn procedurally
(Pillow + code-written SVG icons). Every animation is keyed to a word of the real narration through at(), which tries
the exact token, then a spaces-free substring match across tokens, then the word's relative position in the segment
text, so an edited or re-voiced script never crashes the render (misses are reported to QA)."""
import math, random, re, sys, traceback
from PIL import Image, ImageDraw
from . import core
from .core import (W, H, SEG, clamp, lerp, eo, eio, eob, pop, fade, text_img, put, F, rrect, draw_cat,
                   talk_amount, arrow, confetti, rays, heart, comment_icon, stars)
from .characters import draw_person
from .props import check, stamp
from .icons import icon, NAMES as ICON_NAMES

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

def tblock(txt, size, maxw, weight=800, fill=WHITE, stroke=0, sfill=INK, max_lines=3, lh=1.12, align='center'):
    """Wrapped, centred text as one RGBA image; shrinks the font until it fits in max_lines."""
    txt = str(txt or '').strip()
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


def mascots(img, t, seg, sp, default_cat=True):
    talk = talk_amount(t)
    p = sp.get('person')
    if p:
        p = p if isinstance(p, dict) else {}
        mood = p.get('mood', 'normal')
        r = p.get('react')
        if isinstance(r, dict) and t >= at(seg, r.get('at'), 0.5):
            mood = r.get('mood', mood)
        x = {'left': 190, 'right': 890, 'center': 540}.get(p.get('x', 'left'), 190)
        style = OUTFITS.get(p.get('outfit', 'navy'), {})
        draw_person(img, x, 1255, 150, t, style=style, pose='stand', mood=mood if mood in ('normal', 'happy', 'shock', 'think') else 'normal',
                    glasses=p.get('glasses', True), hand_chin=mood == 'think', look=(0.3 if x < 540 else -0.3, -0.2))
    c = sp.get('cat', {} if default_cat else None)
    if c is not None and c is not False:
        c = c if isinstance(c, dict) else {}
        mood = c.get('mood', 'normal')
        r = c.get('react')
        if isinstance(r, dict) and t >= at(seg, r.get('at'), 0.5):
            mood = r.get('mood', mood)
        x = {'left': 180, 'right': 900, 'center': 540}.get(c.get('x', 'right'), 900)
        draw_cat(img, x, 1300, 150, t, mood=mood if mood in ('normal', 'happy', 'shock', 'worried') else 'normal', talk=talk,
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
    mood = p.get('mood', 'normal')
    r = p.get('react')
    if isinstance(r, dict) and t >= at(seg, r.get('at'), 0.5):
        mood = r.get('mood', mood)
    draw_person(img, 380, 860, 250, t, style=OUTFITS.get(p.get('outfit', 'navy'), {}), pose='stand',
                mood=mood if mood in ('normal', 'happy', 'shock', 'think') else 'normal', glasses=p.get('glasses', True),
                hand_chin=mood == 'think', look=(0.4, -0.2))
    c = sp.get('cat', {}) or {}
    c = c if isinstance(c, dict) else {}
    cm = c.get('mood', 'normal')
    cr = c.get('react')
    if isinstance(cr, dict) and t >= at(seg, cr.get('at'), 0.5):
        cm = cr.get('mood', cm)
    draw_cat(img, 830, 1170, 170, t, mood=cm if cm in ('normal', 'happy', 'shock', 'worried') else 'normal', talk=talk, look=(-0.5, -0.2))
    b = sp.get('bubble')
    if b:
        b = b if isinstance(b, dict) else {'text': b}
        tb = at(seg, b.get('at'), 0.1)
        if t >= tb:
            im = tblock(b.get('text'), 58, 620, 800, INK, 0, INK, 3)
            lay = card(im.width + 70, im.height + 60, (255, 255, 255, 250), INK + (255,), 40, 7)
            lay.alpha_composite(im, (35, 30))
            put(img, lay, 680, 560 + lay.height / 2 - 40, pop(t, tb))
    ic = sp.get('icon')
    if ic:
        ti = at(seg, sp.get('icon_at'), 0.3)
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


TEMPLATES = {
    'hook': T_hook, 'number': T_number, 'compare': T_compare, 'bars': T_bars, 'list': T_list, 'quiz': T_quiz, 'reveal': T_reveal,
    'dots': T_dots, 'timeline': T_timeline, 'truth': T_truth, 'scenario': T_scenario, 'icons': T_icons, 'outro': T_outro,
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
    out = {}
    for i, sp in enumerate(spec.get('scenes') or []):
        seg = sp.get('seg')
        if not seg:
            continue
        pal = PALETTES.get(sp.get('bg')) or PALETTES[PAL_ORDER[i % len(PAL_ORDER)]]
        out[seg] = (_scene(seg, sp, i + 3), pal)
    for i, sid in enumerate(core.ORDER):
        if sid not in out:  # a segment the spec forgot still gets a decent scene
            out[sid] = (_scene(sid, {'type': 'scenario', 'bubble': {'text': _TEXT.get(sid, '')[:60]}}, 50 + i), PALETTES[PAL_ORDER[i % len(PAL_ORDER)]])
    return out
