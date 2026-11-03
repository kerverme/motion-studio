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

def draw_person(base, cx, cy, S, t, style=None, pose='stand', mood='normal', talk=0.0, wave=0.0, glint=0.0,
             glasses=True, look=(0.0, 0.0), alpha=1.0, phone=False, hand_chin=False):
    """Chibi Tum: black helmet hair with straight bangs, round glasses, white turtleneck,
    navy blazer, beige chinos, grey loafers. (cx, cy) = centre of the head, S = head width."""
    st = dict(DEFAULT_STYLE); st.update(style or {})
    SKIN, SKIN_D, HAIR = st['skin'], st['skin_shadow'], st['hair']
    NAVY, NAVY_D, WHITE = st['jacket'], st['jacket_dark'], st['inner']
    BEIGE, SHOE, FRAME = st['pants'], st['shoes'], st['frame']
    if not st.get('strap', True):
        pass
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

    # ---- legs
    if pose == 'stand':
        for sg in (-1, 1):
            R(sg * 0.2 - 0.12, 0.98, sg * 0.2 + 0.12, 1.62, 0.06, BEIGE)
            E(sg * 0.22 - 0.16, 1.56, sg * 0.22 + 0.15, 1.7, SHOE)
    else:  # sitting, legs apart like the photo
        for sg in (-1, 1):
            R(sg * 0.24 - 0.13, 0.98, sg * 0.24 + 0.13, 1.22, 0.07, BEIGE)
            R(sg * 0.3 - 0.11, 1.12, sg * 0.3 + 0.11, 1.62, 0.06, BEIGE)
            E(sg * 0.31 - 0.15, 1.56, sg * 0.31 + 0.15, 1.7, SHOE)
    # ---- torso (navy blazer)
    P([(-0.44, 0.62), (0.44, 0.62), (0.4, 1.08), (-0.4, 1.08)], NAVY)
    # white turtleneck chest V
    P([(-0.15, 0.55), (0.15, 0.55), (0.03, 1.0), (-0.03, 1.0)], WHITE, max(1, lw // 2))
    # lapels
    for sg in (-1, 1):
        P([(sg * 0.15, 0.6), (sg * 0.27, 0.66), (sg * 0.1, 0.92), (sg * 0.04, 0.98)], NAVY_D, max(1, lw // 2))
    # bag strap
    if st.get('strap', True):
        d.line((ox - 0.3 * s, oy + 0.62 * s, ox + 0.36 * s, oy + 1.06 * s), fill=(20, 20, 26, 255), width=int(lw * 1.8))
    # turtleneck collar
    R(-0.17, 0.44, 0.17, 0.64, 0.06, WHITE)
    for k in range(3):
        yy = oy + (0.5 + 0.045 * k) * s
        d.line((ox - 0.13 * s, yy, ox + 0.13 * s, yy), fill=(215, 215, 210, 255), width=max(1, lw // 2))
    # ---- arms
    for sg in (-1, 1):
        if sg == 1 and wave > 0.01:
            ang = -1.0 - 0.35 * math.sin(t * 9) * wave
            sx_, sy_ = ox + 0.4 * s, oy + 0.7 * s
            ex_, ey_ = sx_ + 0.48 * s * math.cos(ang), sy_ + 0.48 * s * math.sin(ang)
            d.line((sx_, sy_, ex_, ey_), fill=ol, width=int(0.2 * s))
            d.line((sx_, sy_, ex_, ey_), fill=NAVY + (255,), width=int(0.15 * s))
            r = 0.085 * s
            d.ellipse((ex_ - r, ey_ - r, ex_ + r, ey_ + r), fill=SKIN + (255,), outline=ol, width=lw)
            continue
        if sg == -1 and hand_chin:
            sx_, sy_ = ox - 0.4 * s, oy + 0.7 * s
            ex_, ey_ = ox - 0.12 * s, oy + 0.42 * s
            d.line((sx_, sy_, ex_, ey_), fill=ol, width=int(0.2 * s))
            d.line((sx_, sy_, ex_, ey_), fill=NAVY + (255,), width=int(0.15 * s))
            r = 0.085 * s
            d.ellipse((ex_ - r, ey_ - r, ex_ + r, ey_ + r), fill=SKIN + (255,), outline=ol, width=lw)
            continue
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
    E(-hw, -hh, hw, hh, SKIN)
    # hair helmet: crown + sides + straight bangs
    hp = []
    for i in range(41):
        a = math.pi + math.pi * i / 40
        hp.append((math.cos(a) * 0.56, -0.04 + math.sin(a) * 0.58))
    hp += [(0.55, 0.02), (0.47, 0.06), (0.44, -0.12)]
    # bangs edge (slightly jagged)
    n = 12
    for i in range(n + 1):
        x = 0.42 - 0.84 * i / n
        y = -0.15 + (0.025 if i % 2 else 0.0)
        hp.append((x, y))
    hp += [(-0.44, -0.12), (-0.47, 0.06), (-0.55, 0.02)]
    P(hp, HAIR)
    # hair shine
    d.arc((ox - 0.36 * s, oy - 0.52 * s, ox + 0.1 * s, oy - 0.1 * s), 200, 250, fill=(90, 90, 110, 255), width=int(lw * 1.4))
    # face
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
        if mood == 'think':
            d.line((ex - 0.06 * s, ey - 0.12 * s + sg * 0.01 * s, ex + 0.06 * s, ey - 0.13 * s - sg * 0.01 * s), fill=ol, width=lw)
    # cheeks
    for sg in (-1, 1):
        x, y = fx + sg * 0.3 * s, fy + 0.2 * s
        d.ellipse((x - 0.07 * s, y - 0.035 * s, x + 0.07 * s, y + 0.035 * s), fill=(246, 170, 160, 255))
    # nose + mouth
    d.arc((fx - 0.03 * s, fy + 0.12 * s, fx + 0.03 * s, fy + 0.18 * s), 20, 160, fill=SKIN_D + (255,), width=lw)
    my = fy + 0.3 * s
    if talk > 0.05 or mood == 'shock':
        op = max(talk, 0.7 if mood == 'shock' else 0)
        h = 0.02 * s + 0.07 * s * op
        d.ellipse((fx - 0.06 * s, my - 0.01 * s, fx + 0.06 * s, my + h), fill=(130, 50, 60, 255), outline=ol, width=max(1, lw // 2))
    elif mood == 'happy':
        d.chord((fx - 0.09 * s, my - 0.07 * s, fx + 0.09 * s, my + 0.07 * s), 0, 180, fill=(130, 50, 60, 255), outline=ol, width=max(1, lw // 2))
    else:
        d.arc((fx - 0.07 * s, my - 0.05 * s, fx + 0.07 * s, my + 0.03 * s), 30, 150, fill=ol, width=lw)
    # glasses
    if glasses:
        fw = max(2, int((0.026 if S > 200 else 0.05) * s))
        for sg in (-1, 1):
            ex, ey = fx + sg * 0.2 * s, fy + 0.04 * s
            r = 0.15 * s
            d.ellipse((ex - r, ey - r, ex + r, ey + r), outline=FRAME + (255,), width=fw)
            d.line((ex + sg * r, ey - 0.02 * s, fx + sg * 0.5 * s, ey - 0.05 * s), fill=FRAME + (255,), width=fw)
            if glint > 0.15:
                gw = max(1, int(fw * 1.8 * glint))
                d.line((ex - 0.08 * s, ey + 0.02 * s, ex - 0.01 * s, ey - 0.08 * s), fill=(255, 255, 255, 255), width=gw)
                d.line((ex + 0.01 * s, ey + 0.06 * s, ex + 0.06 * s, ey - 0.01 * s), fill=(255, 255, 255, 255), width=max(1, gw // 2))
        d.arc((fx - 0.06 * s, fy - 0.03 * s, fx + 0.06 * s, fy + 0.06 * s), 200, 340, fill=FRAME + (255,), width=fw)
        if glint > 0.3:
            # star sparkle
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


