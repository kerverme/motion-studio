"""Reusable code-drawn props, sets and infographic widgets."""
from .core import *
from .characters import *

def wall_scene(img, d, t, lamp=True):
    """Red brick wall with teal-framed window, ivy, green chalkboard, lantern, wooden bench and paving."""
    d.rectangle((0, 0, W, 1420), fill=(150, 72, 58, 255))
    bh, bw = 36, 112
    for r in range(0, 1420 // bh + 1):
        y = r * bh
        off = (bw // 2) if r % 2 else 0
        for c in range(-1, W // bw + 2):
            x = c * bw + off
            shade = ((r * 7 + c * 13) % 5) * 6
            d.rectangle((x + 3, y + 3, x + bw - 3, y + bh - 3), fill=(168 - shade, 82 - shade // 2, 64 - shade // 2, 255))
    # door at left
    d.rectangle((0, 380, 120, 1300), fill=(80, 50, 38, 255), outline=(50, 30, 22, 255), width=8)
    # window
    d.rectangle((610, 560, 1010, 860), fill=(40, 120, 125, 255))
    d.rectangle((632, 582, 988, 838), fill=(52, 58, 62, 255))
    d.line((810, 582, 810, 838), fill=(40, 120, 125, 255), width=14)
    d.line((632, 710, 988, 710), fill=(40, 120, 125, 255), width=14)
    # chalkboard
    d.rectangle((290, 660, 520, 950), fill=(60, 50, 40, 255))
    d.rectangle((302, 672, 508, 938), fill=(46, 92, 78, 255))
    ti = text_img('ตั้มอยู่ไหน?', 34, 600, (235, 240, 230), 0)
    comp(img, ti, 405 - ti.width / 2, 700)
    for i in range(6):
        y = 760 + i * 28
        d.line((322, y, 322 + 150 - (i * 23) % 60, y), fill=(220, 228, 220, 200), width=4)
    # ivy
    rnd = random.Random(4)
    for i in range(140):
        u = i / 140
        x = 850 + math.sin(u * 9) * 60 + rnd.uniform(-60, 60) + u * 60
        y = 420 + u * 1000
        r = rnd.uniform(14, 26)
        sw = math.sin(t * 1.5 + i) * 3
        col = (rnd.randint(110, 170), rnd.randint(185, 225), rnd.randint(70, 110), 255)
        d.ellipse((x - r + sw, y - r, x + r + sw, y + r * 0.8), fill=col)
    # lantern
    if lamp:
        glow = 70 + int(20 * math.sin(t * 3))
        d.ellipse((900 - 140, 200 - 140, 900 + 140, 200 + 140), fill=(255, 210, 120, glow // 3))
        d.rectangle((870, 150, 930, 250), fill=(255, 225, 150, 255), outline=(50, 40, 30, 255), width=8)
        d.rectangle((860, 140, 940, 155), fill=(50, 40, 30, 255))
    # ground: gravel strip + paving
    d.rectangle((0, 1300, W, 1420), fill=(205, 190, 168, 255))
    d.rectangle((0, 1420, W, 1920), fill=(170, 100, 90, 255))
    for r in range(4):
        for c in range(9):
            x = c * 130 + (65 if r % 2 else 0)
            d.rectangle((x, 1420 + r * 60 + 4, x + 124, 1420 + r * 60 + 56), fill=(182, 112, 100, 255))
    # bench
    d.rectangle((120, 1150, 1000, 1185), fill=(105, 66, 44, 255), outline=(60, 38, 26, 255), width=6)
    for x in (230, 870):
        d.rectangle((x, 1185, x + 30, 1330), fill=(90, 56, 38, 255))


def crowd(d, cx, cy, wdt, hgt, n, t, col=(90, 80, 120, 255), seed=1, frac=1.0):
    rnd = random.Random(seed)
    for i in range(int(n * frac)):
        x = cx + rnd.uniform(-wdt / 2, wdt / 2)
        y = cy + rnd.uniform(-hgt / 2, hgt / 2)
        r = rnd.uniform(9, 14)
        c = (col[0] + rnd.randint(-30, 30), col[1] + rnd.randint(-30, 30), col[2] + rnd.randint(-30, 30), 255)
        c = tuple(max(0, min(255, v)) for v in c)
        d.ellipse((x - r, y - r, x + r, y + r), fill=c)
        d.rounded_rectangle((x - r * 1.3, y + r * 1.1, x + r * 1.3, y + r * 3), int(r), fill=c)


def check(d, x, y, sz, ok, a=255):
    if ok:
        d.line((x - sz * 0.5, y, x - sz * 0.1, y + sz * 0.4, x + sz * 0.6, y - sz * 0.5), fill=(40, 180, 110, a), width=int(sz * 0.22), joint='curve')
    else:
        d.line((x - sz * 0.45, y - sz * 0.45, x + sz * 0.45, y + sz * 0.45), fill=(235, 60, 80, a), width=int(sz * 0.22))
        d.line((x - sz * 0.45, y + sz * 0.45, x + sz * 0.45, y - sz * 0.45), fill=(235, 60, 80, a), width=int(sz * 0.22))


def stamp(img, txt, cx, cy, t, t0, col=(235, 60, 80), size=110, rot=-10):
    if t < t0: return
    u = (t - t0) / 0.22
    sc = 1.6 - 0.6 * eo(u) if u < 1 else 1.0
    tim = text_img(txt, size, 900, col, 10, (255, 255, 255))
    put(img, tim, cx, cy, sc, clamp(u * 2), rot)


def headline(img, t, l1, t1, l2=None, t2=None, col2=(255, 225, 60), sf=(30, 20, 60)):
    ptext(img, l1, 540, 300, 90, t, t1, sfill=sf)
    if l2 and t >= t2:
        ptext(img, l2, 540, 420, 80, t, t2, fill=col2, sfill=sf)


