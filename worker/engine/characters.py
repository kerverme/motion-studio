"""Code-drawn characters: parametric chibi person (draw_person) and helpers.
The jelly cat lives in engine.core.draw_cat."""
from .core import *
from .core import _timg

DEFAULT_STYLE = {
    # chibi person, defaults reproduce the EP002 "Tum" reference photo:
    # black helmet hair with bangs, round brown glasses, white turtleneck, navy blazer, beige chinos, grey loafers
    'skin': (244, 207, 178), 'skin_shadow': (205, 150, 120), 'hair': (24, 24, 34),
    'jacket': (36, 52, 110), 'jacket_dark': (22, 32, 74), 'inner': (250, 250, 248),
    'pants': (226, 208, 178), 'shoes': (150, 135, 125), 'frame': (120, 86, 60), 'strap': True,
}
INK = (30, 24, 40)

# ---- look options (any combination; the defaults above are Tum from EP002)
HAIRSTYLES = ['helmet', 'short', 'spiky', 'side_part', 'curly', 'bald', 'long', 'bob', 'ponytail', 'bun']
TOPS = ['blazer', 'tshirt', 'hoodie', 'shirt', 'dress']
BOTTOMS = ['pants', 'shorts', 'skirt']
ACCESSORIES = ['cap', 'headband', 'bow', 'earrings', 'mustache', 'beard', 'lashes', 'bag']
HAIR_COLORS = {'black': (24, 24, 34), 'brown': (92, 58, 36), 'blonde': (226, 186, 96), 'grey': (170, 170, 178), 'white': (236, 236, 240),
               'red': (170, 60, 40), 'pink': (240, 130, 170), 'blue': (70, 110, 210), 'purple': (130, 80, 190)}
SKINS = {'light': ((248, 220, 196), (208, 160, 132)), 'medium': ((244, 207, 178), (205, 150, 120)), 'tan': ((214, 166, 126), (170, 118, 84)),
         'brown': ((168, 116, 82), (126, 82, 56)), 'dark': ((118, 78, 54), (84, 52, 34))}
CLOTH = {'navy': (36, 52, 110), 'red': (206, 64, 72), 'green': (44, 146, 100), 'purple': (116, 74, 196), 'orange': (238, 134, 44), 'grey': (116, 122, 136),
         'white': (240, 240, 236), 'black': (40, 40, 48), 'yellow': (246, 196, 52), 'pink': (240, 130, 170), 'sky': (96, 170, 236), 'brown': (130, 90, 60),
         'beige': (226, 208, 178), 'denim': (70, 100, 150), 'mint': (120, 210, 180)}


def _c(v, table, default):
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        return tuple(int(x) for x in v[:3])
    return table.get(str(v or '').lower(), default)


def look_style(look):
    """Turn a friendly look description ({hairstyle, hair_color, skin, top, top_color, bottom, bottom_color, glasses, accessories})
    into a draw_person style dict. Unknown values fall back to Tum's defaults."""
    look = look or {}
    st = {}
    if look.get('hairstyle') in HAIRSTYLES:
        st['hairstyle'] = look['hairstyle']
    if look.get('hair_color'):
        st['hair'] = _c(look['hair_color'], HAIR_COLORS, DEFAULT_STYLE['hair'])
    sk = look.get('skin')
    if isinstance(sk, (list, tuple)) and len(sk) >= 3:   # an exact tone sampled from an uploaded photo
        st['skin'] = tuple(max(0, min(255, int(v))) for v in sk[:3])
        st['skin_shadow'] = tuple(int(v * 0.82) for v in st['skin'])
    elif sk in SKINS:
        st['skin'], st['skin_shadow'] = SKINS[sk]
    if look.get('top') in TOPS:
        st['top'] = look['top']
    if look.get('top_color'):
        c = _c(look['top_color'], CLOTH, DEFAULT_STYLE['jacket'])
        st['jacket'], st['jacket_dark'] = c, tuple(max(0, int(v * 0.7)) for v in c)
    if look.get('inner_color'):
        st['inner'] = _c(look['inner_color'], CLOTH, DEFAULT_STYLE['inner'])
    if look.get('bottom') in BOTTOMS:
        st['bottom'] = look['bottom']
    if look.get('bottom_color'):
        st['pants'] = _c(look['bottom_color'], CLOTH, DEFAULT_STYLE['pants'])
    if look.get('accessory_color'):
        st['acc'] = _c(look['accessory_color'], CLOTH, (230, 70, 90))
    acc = look.get('accessories') or []
    if isinstance(acc, str):
        acc = [acc]
    st['accessories'] = [a for a in acc if a in ACCESSORIES]
    st['strap'] = 'bag' in st['accessories'] or (not look and True)
    g = look.get('glasses', None)
    if g in ('round', 'square', 'none'):
        st['glasses'] = g
    elif g is True:
        st['glasses'] = 'round'
    else:
        st['glasses'] = 'none' if (look or g is False) else 'round'
    return st

def draw_person(base, cx, cy, S, t, style=None, pose='stand', mood='normal', talk=0.0, wave=0.0, glint=0.0,
             glasses=True, look=(0.0, 0.0), alpha=1.0, phone=False, hand_chin=False):
    """Parametric chibi person. With no style it is Tum (EP002): black helmet hair with straight bangs, round glasses,
    white turtleneck, navy blazer, beige chinos, grey loafers. style keys (see look_style): hairstyle, hair, skin, skin_shadow,
    top, jacket, jacket_dark, inner, bottom, pants, shoes, frame, glasses (round|square|none), accessories, acc, strap.
    (cx, cy) = centre of the head, S = head width."""
    st = dict(DEFAULT_STYLE); st.update(style or {})
    SKIN, SKIN_D, HAIR = st['skin'], st['skin_shadow'], st['hair']
    NAVY, NAVY_D, WHITE = st['jacket'], st['jacket_dark'], st['inner']
    BEIGE, SHOE, FRAME = st['pants'], st['shoes'], st['frame']
    HS = st.get('hairstyle', 'helmet')
    TOP = st.get('top', 'blazer')
    BOT = st.get('bottom', 'skirt' if TOP == 'dress' else 'pants')
    ACC = set(st.get('accessories') or [])
    ACCC = tuple(st.get('acc') or (230, 70, 90))
    gl = st.get('glasses')
    gl = 'none' if (not glasses or gl == 'none') else (gl if gl in ('round', 'square') else 'round')
    HAIR_HI = tuple(min(255, int(v * 1.6 + 40)) for v in HAIR)
    S = max(10, S)
    L = int(S * 3.6 * K)
    s = S * K
    lay = Image.new('RGBA', (L, L), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay, 'RGBA')
    ox, oy = L / 2, L * 0.3
    lw = max(2, int(0.028 * s))
    ol = INK + (255,)
    bob = math.sin(t * 2.2) * 0.012 * s
    oy += bob

    def E(x0, y0, x1, y1, f, w=lw):
        d.ellipse((ox + x0 * s, oy + y0 * s, ox + x1 * s, oy + y1 * s), fill=f + (255,), outline=ol, width=w)

    def R(x0, y0, x1, y1, r, f, w=lw):
        d.rounded_rectangle((ox + x0 * s, oy + y0 * s, ox + x1 * s, oy + y1 * s), int(r * s), fill=f + (255,), outline=ol, width=w)

    def P(pts, f, w=lw):
        q = [(ox + x * s, oy + y * s) for x, y in pts]
        d.polygon(q, fill=f + (255,))
        d.line(q + [q[0]], fill=ol, width=w, joint='curve')

    def arc_pts(cx_, cy_, rx, ry, a0, a1, n=24):
        return [(cx_ + math.cos(a0 + (a1 - a0) * i / n) * rx, cy_ + math.sin(a0 + (a1 - a0) * i / n) * ry) for i in range(n + 1)]

    # ---- hair that sits behind the head and body
    if HS == 'long':
        R(-0.6, -0.4, 0.6, 1.0, 0.3, HAIR)
    elif HS == 'bob':
        R(-0.6, -0.4, 0.6, 0.42, 0.22, HAIR)
    elif HS == 'ponytail':
        sw = math.sin(t * 3.0) * 0.03
        P([(0.42, -0.25), (0.66 + sw, -0.05), (0.74 + sw, 0.35), (0.62 + sw, 0.62), (0.5, 0.3), (0.46, 0.0)], HAIR)
    elif HS == 'bun':
        E(-0.2, -0.86, 0.2, -0.46, HAIR)
    if TOP == 'hoodie':
        E(-0.36, 0.3, 0.36, 0.72, NAVY_D)

    # ---- legs
    legc = SKIN if BOT in ('shorts', 'skirt') else BEIGE
    if pose == 'stand':
        for sg in (-1, 1):
            R(sg * 0.2 - 0.12, 0.98, sg * 0.2 + 0.12, 1.62, 0.06, legc)
            if BOT == 'shorts':
                R(sg * 0.2 - 0.13, 0.98, sg * 0.2 + 0.13, 1.24, 0.05, BEIGE)
            E(sg * 0.22 - 0.16, 1.56, sg * 0.22 + 0.15, 1.7, SHOE)
    else:  # sitting, legs apart like the photo
        for sg in (-1, 1):
            R(sg * 0.24 - 0.13, 0.98, sg * 0.24 + 0.13, 1.22, 0.07, BEIGE if BOT != 'skirt' else legc)
            R(sg * 0.3 - 0.11, 1.12, sg * 0.3 + 0.11, 1.62, 0.06, legc if BOT != 'pants' else BEIGE)
            E(sg * 0.31 - 0.15, 1.56, sg * 0.31 + 0.15, 1.7, SHOE)
    if BOT == 'skirt':
        skc = NAVY if TOP == 'dress' else BEIGE
        P([(-0.4, 0.98), (0.4, 0.98), (0.56, 1.36), (-0.56, 1.36)], skc)

    # ---- torso
    if TOP == 'blazer':
        P([(-0.44, 0.62), (0.44, 0.62), (0.4, 1.08), (-0.4, 1.08)], NAVY)
        P([(-0.15, 0.55), (0.15, 0.55), (0.03, 1.0), (-0.03, 1.0)], WHITE, max(1, lw // 2))
        for sg in (-1, 1):
            P([(sg * 0.15, 0.6), (sg * 0.27, 0.66), (sg * 0.1, 0.92), (sg * 0.04, 0.98)], NAVY_D, max(1, lw // 2))
    elif TOP == 'dress':
        P([(-0.38, 0.62), (0.38, 0.62), (0.36, 1.02), (-0.36, 1.02)], NAVY)
        R(-0.37, 0.92, 0.37, 1.0, 0.03, NAVY_D, max(1, lw // 2))
    else:
        P([(-0.44, 0.62), (0.44, 0.62), (0.4, 1.08), (-0.4, 1.08)], NAVY)
        if TOP == 'shirt':
            d.line((ox, oy + 0.66 * s, ox, oy + 1.06 * s), fill=NAVY_D + (255,), width=max(1, lw // 2))
            for k in range(3):
                yy = oy + (0.74 + 0.1 * k) * s
                d.ellipse((ox - 0.018 * s, yy - 0.018 * s, ox + 0.018 * s, yy + 0.018 * s), fill=WHITE + (255,))
        if TOP == 'hoodie':
            R(-0.2, 0.86, 0.2, 1.02, 0.05, NAVY_D, max(1, lw // 2))
            for sg in (-1, 1):
                d.line((ox + sg * 0.08 * s, oy + 0.62 * s, ox + sg * 0.09 * s, oy + 0.8 * s), fill=WHITE + (255,), width=max(1, lw))
    if st.get('strap', True) and TOP == 'blazer' or 'bag' in ACC:
        d.line((ox - 0.3 * s, oy + 0.62 * s, ox + 0.36 * s, oy + 1.06 * s), fill=(20, 20, 26, 255), width=int(lw * 1.8))
    # neck / collar
    if TOP == 'blazer':
        R(-0.17, 0.44, 0.17, 0.64, 0.06, WHITE)
        for k in range(3):
            yy = oy + (0.5 + 0.045 * k) * s
            d.line((ox - 0.13 * s, yy, ox + 0.13 * s, yy), fill=(215, 215, 210, 255), width=max(1, lw // 2))
    else:
        R(-0.1, 0.46, 0.1, 0.64, 0.05, SKIN)
        if TOP == 'shirt':
            for sg in (-1, 1):
                P([(sg * 0.02, 0.6), (sg * 0.2, 0.58), (sg * 0.13, 0.74)], WHITE, max(1, lw // 2))
        elif TOP in ('tshirt', 'dress'):
            d.arc((ox - 0.15 * s, oy + 0.5 * s, ox + 0.15 * s, oy + 0.72 * s), 0, 180, fill=NAVY_D + (255,), width=lw)

    # ---- arms
    short_sleeve = TOP in ('tshirt', 'dress')

    def arm_line(sx_, sy_, ex_, ey_):
        d.line((sx_, sy_, ex_, ey_), fill=ol, width=int(0.2 * s))
        if short_sleeve:
            mx_, my_ = (sx_ + ex_) / 2, (sy_ + ey_) / 2
            d.line((mx_, my_, ex_, ey_), fill=SKIN + (255,), width=int(0.15 * s))
            d.line((sx_, sy_, mx_, my_), fill=NAVY + (255,), width=int(0.15 * s))
        else:
            d.line((sx_, sy_, ex_, ey_), fill=NAVY + (255,), width=int(0.15 * s))
        r = 0.085 * s
        d.ellipse((ex_ - r, ey_ - r, ex_ + r, ey_ + r), fill=SKIN + (255,), outline=ol, width=lw)

    for sg in (-1, 1):
        if sg == 1 and wave > 0.01:
            ang = -1.0 - 0.35 * math.sin(t * 9) * wave
            sx_, sy_ = ox + 0.4 * s, oy + 0.7 * s
            arm_line(sx_, sy_, sx_ + 0.48 * s * math.cos(ang), sy_ + 0.48 * s * math.sin(ang))
            continue
        if sg == -1 and hand_chin:
            arm_line(ox - 0.4 * s, oy + 0.7 * s, ox - 0.12 * s, oy + 0.42 * s)
            continue
        if short_sleeve:
            R(sg * 0.42 - 0.09, 0.64, sg * 0.42 + 0.09, 1.04, 0.08, SKIN)
            R(sg * 0.42 - 0.1, 0.62, sg * 0.42 + 0.1, 0.8, 0.06, NAVY)
        else:
            R(sg * 0.42 - 0.09, 0.64, sg * 0.42 + 0.09, 1.04, 0.08, NAVY)
        hx = sg * 0.36 if pose == 'stand' else sg * 0.15
        hy = 1.06 if pose == 'stand' else 1.02
        E(hx - 0.08, hy - 0.07, hx + 0.08, hy + 0.07, SKIN)
    if phone and pose != 'stand':
        R(-0.08, 0.92, 0.08, 1.08, 0.02, (40, 40, 48))

    # ---- head
    hw, hh = 0.5, 0.52
    for sg in (-1, 1):
        E(sg * hw - 0.08, -0.06, sg * hw + 0.08, 0.14, SKIN)
    if 'earrings' in ACC:
        for sg in (-1, 1):
            E(sg * hw - 0.035, 0.14, sg * hw + 0.035, 0.21, ACCC, max(1, lw // 2))
    E(-hw, -hh, hw, hh, SKIN)
    if 'beard' in ACC:
        bp = arc_pts(0, 0.0, 0.5, 0.52, 0.25, math.pi - 0.25, 20)
        bp += [(-0.34, 0.24), (-0.14, 0.4), (0.14, 0.4), (0.34, 0.24)]
        P(bp, HAIR, max(1, lw // 2))

    # ---- hair in front
    top_arc = arc_pts(0, -0.04, 0.56, 0.58, math.pi, 2 * math.pi, 40)
    if HS == 'helmet':
        hp = list(top_arc) + [(0.55, 0.02), (0.47, 0.06), (0.44, -0.12)]
        n = 12
        for i in range(n + 1):
            hp.append((0.42 - 0.84 * i / n, -0.15 + (0.025 if i % 2 else 0.0)))
        hp += [(-0.44, -0.12), (-0.47, 0.06), (-0.55, 0.02)]
        P(hp, HAIR)
    elif HS in ('short', 'spiky', 'side_part'):
        if HS == 'spiky':
            hp = []
            for i in range(17):
                a = math.pi + math.pi * i / 16
                rr = 0.56 if i % 2 == 0 else 0.74
                hp.append((math.cos(a) * rr * 1.0, -0.06 + math.sin(a) * rr))
        else:
            hp = arc_pts(0, -0.06, 0.55, 0.56, math.pi, 2 * math.pi, 32)
        hp += [(0.52, -0.02), (0.47, -0.04), (0.44, -0.22)]
        if HS == 'side_part':
            hp += [(0.3, -0.4), (0.0, -0.36), (-0.3, -0.26), (-0.42, -0.16)]
        else:
            hp += [(0.25, -0.31), (0.0, -0.29), (-0.25, -0.31)]
            hp += [(-0.44, -0.22)]
        hp += [(-0.47, -0.04), (-0.52, -0.02)]
        P(hp, HAIR)
        if HS == 'side_part':
            d.line((ox + 0.12 * s, oy - 0.58 * s, ox + 0.22 * s, oy - 0.38 * s), fill=ol, width=lw)
    elif HS == 'curly':
        rnd = random.Random(7)
        for i in range(15):
            a = math.pi * 0.92 + math.pi * 1.16 * i / 14
            x, y = math.cos(a) * 0.52, -0.08 + math.sin(a) * 0.54
            r = 0.15 + 0.02 * rnd.random()
            E(x - r, y - r, x + r, y + r, HAIR, max(1, int(lw * 0.8)))
        E(-0.46, -0.6, 0.46, -0.18, HAIR, 0)
        for i in range(5):
            x = -0.32 + 0.16 * i
            E(x - 0.11, -0.4, x + 0.11, -0.18, HAIR, max(1, int(lw * 0.8)))
    elif HS in ('long', 'bob', 'ponytail', 'bun'):
        hp = list(top_arc)
        down = {'long': 0.62, 'bob': 0.36, 'ponytail': -0.06, 'bun': -0.06}[HS]
        hp += [(0.56, down), (0.44, down), (0.44, -0.1)]
        if HS in ('long', 'bob'):  # centre-parted bangs
            hp += [(0.36, -0.16), (0.2, -0.24), (0.06, -0.3), (0.0, -0.36), (-0.06, -0.3), (-0.2, -0.24), (-0.36, -0.16), (-0.44, -0.1)]
        elif HS == 'ponytail':  # side-swept fringe
            hp += [(0.3, -0.18), (0.05, -0.12), (-0.25, -0.2), (-0.44, -0.12)]
        else:  # bun: hair pulled back, forehead shows
            hp += [(0.3, -0.36), (0.0, -0.42), (-0.3, -0.36), (-0.44, -0.1)]
        hp += [(-0.44, down), (-0.56, down)]
        P(hp, HAIR)
    if HS != 'bald' and HS != 'curly':
        d.arc((ox - 0.36 * s, oy - 0.52 * s, ox + 0.1 * s, oy - 0.1 * s), 200, 250, fill=HAIR_HI + (255,), width=int(lw * 1.4))
    elif HS == 'bald':
        d.arc((ox - 0.3 * s, oy - 0.46 * s, ox + 0.0 * s, oy - 0.2 * s), 200, 250, fill=(255, 255, 255, 160), width=int(lw * 1.4))
    # head accessories
    if 'cap' in ACC:
        P(arc_pts(0, -0.18, 0.56, 0.44, math.pi, 2 * math.pi, 24) + [(0.56, -0.18), (-0.56, -0.18)], ACCC)
        P([(-0.1, -0.24), (0.78, -0.18), (0.74, -0.1), (-0.1, -0.14)], tuple(int(v * 0.75) for v in ACCC))
    if 'headband' in ACC:
        d.arc((ox - 0.56 * s, oy - 0.62 * s, ox + 0.56 * s, oy + 0.1 * s), 190, 350, fill=ACCC + (255,), width=int(0.08 * s))
    if 'bow' in ACC:
        bx, by = 0.36, -0.5
        P([(bx, by), (bx + 0.18, by - 0.12), (bx + 0.18, by + 0.1)], ACCC, max(1, lw // 2))
        P([(bx, by), (bx - 0.18, by - 0.12), (bx - 0.18, by + 0.1)], ACCC, max(1, lw // 2))
        E(bx - 0.05, by - 0.05, bx + 0.05, by + 0.05, ACCC, max(1, lw // 2))

    # ---- face
    fx = ox + look[0] * 0.04 * s
    fy = oy + look[1] * 0.03 * s
    blink = (t % 4.1) < 0.12
    for sg in (-1, 1):
        ex, ey = fx + sg * 0.2 * s, fy + 0.04 * s
        if mood == 'happy':
            d.arc((ex - 0.06 * s, ey - 0.04 * s, ex + 0.06 * s, ey + 0.05 * s), 200, 340, fill=ol, width=lw)
        elif blink:
            d.line((ex - 0.05 * s, ey, ex + 0.05 * s, ey), fill=ol, width=lw)
        elif mood == 'shock':
            r = 0.055 * s
            d.ellipse((ex - r, ey - r, ex + r, ey + r), fill=(255, 255, 255, 255), outline=ol, width=lw)
            r2 = 0.02 * s
            d.ellipse((ex - r2, ey - r2, ex + r2, ey + r2), fill=ol)
        else:
            r = 0.04 * s
            d.ellipse((ex - r, ey - r * 1.15, ex + r, ey + r * 1.15), fill=ol)
            r2 = 0.014 * s
            d.ellipse((ex - 0.012 * s - r2, ey - 0.018 * s - r2, ex - 0.012 * s + r2, ey - 0.018 * s + r2), fill=(255, 255, 255, 255))
        if 'lashes' in ACC and mood != 'happy' and not blink:
            d.line((ex + sg * 0.045 * s, ey - 0.03 * s, ex + sg * 0.085 * s, ey - 0.065 * s), fill=ol, width=lw)
        if mood == 'think':
            d.line((ex - 0.06 * s, ey - 0.12 * s + sg * 0.01 * s, ex + 0.06 * s, ey - 0.13 * s - sg * 0.01 * s), fill=ol, width=lw)
    for sg in (-1, 1):
        x, y = fx + sg * 0.3 * s, fy + 0.2 * s
        d.ellipse((x - 0.07 * s, y - 0.035 * s, x + 0.07 * s, y + 0.035 * s), fill=(246, 170, 160, 255))
    d.arc((fx - 0.03 * s, fy + 0.12 * s, fx + 0.03 * s, fy + 0.18 * s), 20, 160, fill=SKIN_D + (255,), width=lw)
    if 'mustache' in ACC:
        for sg in (-1, 1):
            d.chord((fx + (0 if sg > 0 else -0.14) * s, fy + 0.18 * s, fx + (0.14 if sg > 0 else 0) * s, fy + 0.27 * s), 180, 360, fill=HAIR + (255,))
    my = fy + 0.3 * s
    if talk > 0.05 or mood == 'shock':
        op = max(talk, 0.7 if mood == 'shock' else 0)
        h = 0.02 * s + 0.07 * s * op
        d.ellipse((fx - 0.06 * s, my - 0.01 * s, fx + 0.06 * s, my + h), fill=(130, 50, 60, 255), outline=ol, width=max(1, lw // 2))
    elif mood == 'happy':
        d.chord((fx - 0.09 * s, my - 0.07 * s, fx + 0.09 * s, my + 0.07 * s), 0, 180, fill=(130, 50, 60, 255), outline=ol, width=max(1, lw // 2))
    else:
        d.arc((fx - 0.07 * s, my - 0.05 * s, fx + 0.07 * s, my + 0.03 * s), 30, 150, fill=ol, width=lw)
    # ---- glasses
    if gl != 'none':
        fw = max(2, int((0.026 if S > 200 else 0.05) * s))
        for sg in (-1, 1):
            ex, ey = fx + sg * 0.2 * s, fy + 0.04 * s
            r = 0.15 * s
            if gl == 'square':
                d.rounded_rectangle((ex - r, ey - r * 0.75, ex + r, ey + r * 0.75), int(0.04 * s), outline=FRAME + (255,), width=fw)
            else:
                d.ellipse((ex - r, ey - r, ex + r, ey + r), outline=FRAME + (255,), width=fw)
            d.line((ex + sg * r, ey - 0.02 * s, fx + sg * 0.5 * s, ey - 0.05 * s), fill=FRAME + (255,), width=fw)
            if glint > 0.15:
                gw = max(1, int(fw * 1.8 * glint))
                d.line((ex - 0.08 * s, ey + 0.02 * s, ex - 0.01 * s, ey - 0.08 * s), fill=(255, 255, 255, 255), width=gw)
                d.line((ex + 0.01 * s, ey + 0.06 * s, ex + 0.06 * s, ey - 0.01 * s), fill=(255, 255, 255, 255), width=max(1, gw // 2))
        d.arc((fx - 0.06 * s, fy - 0.03 * s, fx + 0.06 * s, fy + 0.06 * s), 200, 340, fill=FRAME + (255,), width=fw)
        if glint > 0.3:
            gx, gy = fx + 0.33 * s, fy - 0.1 * s
            rr = 0.09 * s * glint
            d.polygon([(gx, gy - rr), (gx + rr * 0.25, gy - rr * 0.25), (gx + rr, gy), (gx + rr * 0.25, gy + rr * 0.25), (gx, gy + rr),
                       (gx - rr * 0.25, gy + rr * 0.25), (gx - rr, gy), (gx - rr * 0.25, gy - rr * 0.25)], fill=(255, 255, 220, 255))
    lay = lay.reduce(K)
    if alpha < 0.999:
        lay.putalpha(lay.getchannel('A').point(lambda v: int(v * alpha)))
    comp(base, lay, cx - ox / K, cy - oy / K + bob / K)


_ticons = {}
def person_icon(size, style=None, glasses=True, happy=False):
    key = (size, json.dumps(style or {}, sort_keys=True), glasses, happy)
    if key not in _ticons:
        im = Image.new('RGBA', (size, int(size * 1.15)), (0, 0, 0, 0))
        draw_person(im, size / 2, size * 0.5, size * 0.78, 0.0, style=style, glasses=glasses, mood='happy' if happy else 'normal')
        _ticons[key] = im.crop((0, 0, size, int(size * 1.0)))
    return _ticons[key]


