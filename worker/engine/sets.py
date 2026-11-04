"""Code-drawn locations ("sets") a scene can stand in. Each fills the whole frame; the floor/ground line is at FLOOR so
characters in scenario scenes stand on it. Everything is procedural (Pillow), with gentle motion where it helps."""
import math, random
from PIL import ImageDraw
from .core import W, H, gradient, cloud, stars
from .props import wall_scene

FLOOR = 1290


def _sky(img, top, bot, y1=H):
    g = gradient(top, bot).crop((0, 0, W, y1))
    img.paste(g, (0, 0))


def set_city(img, d, t):
    _sky(img, (120, 190, 245), (210, 236, 255), FLOOR)
    for k in range(3):
        cloud(d, ((180 + 420 * k + t * 18) % (W + 300)) - 150, 260 + 70 * k, 0.9 + 0.2 * k, 200)
    rnd = random.Random(21)
    for layer, (col, win, y0, hmin, hmax) in enumerate((((150, 170, 205), (190, 210, 235), 900, 200, 520), ((86, 104, 150), (250, 226, 140), 1000, 160, 420))):
        x = -40
        while x < W + 40:
            bw = rnd.randint(110, 190)
            bh = rnd.randint(hmin, hmax)
            top = FLOOR - bh - (0 if layer else 120)
            d.rectangle((x, top, x + bw, FLOOR), fill=col + (255,))
            for wy in range(top + 24, FLOOR - 30, 46):
                for wx in range(x + 16, x + bw - 26, 34):
                    if rnd.random() < 0.7:
                        d.rectangle((wx, wy, wx + 16, wy + 22), fill=win + (255,))
            x += bw + rnd.randint(4, 26)
    d.rectangle((0, FLOOR, W, H), fill=(120, 124, 136, 255))
    d.rectangle((0, FLOOR, W, FLOOR + 22), fill=(200, 200, 205, 255))
    for x in range(0, W, 160):
        xx = (x - t * 60) % (W + 160) - 80
        d.rectangle((xx, FLOOR + 160, xx + 80, FLOOR + 176), fill=(240, 220, 120, 255))


def set_room(img, d, t):
    d.rectangle((0, 0, W, FLOOR), fill=(244, 226, 200, 255))
    for x in range(0, W, 90):
        d.rectangle((x, 0, x + 44, FLOOR), fill=(238, 216, 188, 255))
    # window
    d.rounded_rectangle((120, 520, 520, 900), 18, fill=(150, 210, 250, 255), outline=(120, 86, 60, 255), width=16)
    cloud(d, 200 + (t * 20) % 200, 640, 0.6, 230)
    d.line((320, 520, 320, 900), fill=(120, 86, 60, 255), width=12)
    d.line((120, 710, 520, 710), fill=(120, 86, 60, 255), width=12)
    for sx in (90, 520):
        d.rounded_rectangle((sx, 500, sx + 40, 960), 16, fill=(220, 110, 100, 255))
    # frame + plant
    d.rounded_rectangle((680, 560, 940, 760), 10, fill=(255, 250, 240, 255), outline=(90, 70, 60, 255), width=12)
    d.polygon([(700, 740), (780, 640), (840, 700), (880, 660), (920, 740)], fill=(110, 180, 130, 255))
    d.ellipse((860, 590, 900, 630), fill=(255, 200, 80, 255))
    d.rectangle((0, FLOOR - 26, W, FLOOR), fill=(200, 170, 140, 255))
    d.rectangle((0, FLOOR, W, H), fill=(176, 122, 82, 255))
    for y in range(FLOOR + 40, H, 70):
        d.line((0, y, W, y), fill=(150, 100, 66, 255), width=4)
    d.rounded_rectangle((900, FLOOR - 170, 1010, FLOOR - 20), 20, fill=(230, 120, 90, 255))
    for k in range(5):
        a = -2.4 + k * 0.4 + math.sin(t * 1.5 + k) * 0.05
        d.ellipse((955 + math.cos(a) * 110 - 40, FLOOR - 170 + math.sin(a) * 120 - 18, 955 + math.cos(a) * 110 + 40, FLOOR - 170 + math.sin(a) * 120 + 18), fill=(80, 170, 100, 255))


def set_classroom(img, d, t):
    d.rectangle((0, 0, W, FLOOR), fill=(214, 236, 214, 255))
    d.rounded_rectangle((80, 230, 1000, 820), 20, fill=(50, 92, 72, 255), outline=(150, 104, 66, 255), width=22)
    for k in range(3):  # chalk smudges
        d.line((160 + 230 * k, 760, 300 + 230 * k, 740), fill=(120, 150, 130, 255), width=6)
    d.rectangle((120, 820, 960, 846), fill=(150, 104, 66, 255))
    d.rectangle((300, 812, 350, 822), fill=(250, 250, 250, 255))
    d.ellipse((880, 120, 980, 220), fill=(255, 255, 255, 255), outline=(60, 60, 70, 255), width=8)
    a = t * 0.5
    d.line((930, 170, 930 + math.cos(a) * 34, 170 + math.sin(a) * 34), fill=(60, 60, 70, 255), width=6)
    d.rectangle((0, FLOOR, W, H), fill=(196, 160, 120, 255))
    for x in range(-60, W, 140):
        d.line((x, FLOOR, x + 200, H), fill=(176, 140, 100, 255), width=4)


def set_park(img, d, t):
    _sky(img, (110, 190, 250), (200, 236, 255), 1150)
    d.ellipse((800, 180, 960, 340), fill=(255, 220, 90, 255))
    for k in range(3):
        cloud(d, ((120 + 380 * k + t * 14) % (W + 300)) - 150, 300 + 90 * k, 0.8, 230)
    d.ellipse((-300, 950, 700, 1400), fill=(120, 196, 120, 255))
    d.ellipse((400, 980, 1400, 1420), fill=(104, 180, 108, 255))
    d.rectangle((0, 1150, W, H), fill=(120, 200, 110, 255))
    d.polygon([(470, H), (610, H), (580, 1150), (520, 1150)], fill=(232, 210, 160, 255))
    for x, s in ((120, 1.0), (930, 1.15), (300, 0.7)):
        sway = math.sin(t * 1.3 + x) * 6
        d.rectangle((x - 18 * s, 1150 - 230 * s, x + 18 * s, 1160), fill=(130, 90, 60, 255))
        for dx, dy, r in ((0, -300, 110), (-70, -240, 90), (70, -240, 90)):
            d.ellipse((x + dx * s - r * s + sway, 1150 + dy * s - r * s, x + dx * s + r * s + sway, 1150 + dy * s + r * s), fill=(70, 160, 90, 255))


def set_beach(img, d, t):
    _sky(img, (90, 180, 245), (190, 232, 255), 1040)
    d.ellipse((140, 200, 300, 360), fill=(255, 220, 90, 255))
    cloud(d, (600 + t * 12) % (W + 300) - 150, 330, 0.9, 230)
    d.rectangle((0, 1040, W, 1220), fill=(40, 150, 210, 255))
    for k in range(5):
        y = 1070 + k * 32
        off = (t * 40 + k * 70) % 120
        for x in range(-120, W + 120, 120):
            d.arc((x + off - 60, y - 14, x + off + 60, y + 14), 200, 340, fill=(220, 245, 255, 255), width=5)
    d.rectangle((0, 1220, W, H), fill=(246, 220, 160, 255))
    d.polygon([(0, 1220), (W, 1200), (W, 1240), (0, 1250)], fill=(250, 240, 210, 255))
    x0 = 900
    d.line((x0, 1300, x0 - 60, 820), fill=(140, 96, 60, 255), width=34)
    for a in (-2.6, -2.1, -1.4, -0.9, -0.4):
        sw = math.sin(t * 1.6 + a) * 0.06
        d.line((x0 - 60, 820, x0 - 60 + math.cos(a + sw) * 230, 820 + math.sin(a + sw) * 120 + 60), fill=(60, 160, 90, 255), width=26)


def set_office(img, d, t):
    d.rectangle((0, 0, W, FLOOR), fill=(214, 224, 236, 255))
    d.rectangle((120, 260, 960, 760), fill=(170, 214, 245, 255), outline=(90, 100, 120, 255), width=14)
    for y in range(290, 760, 34):
        d.line((134, y, 946, y), fill=(236, 240, 246, 255), width=10)
    d.rectangle((0, FLOOR - 230, W, FLOOR - 200), fill=(150, 120, 90, 255))
    d.rectangle((620, FLOOR - 430, 920, FLOOR - 250), fill=(50, 54, 64, 255))
    d.rectangle((640, FLOOR - 410, 900, FLOOR - 270), fill=(110, 190, 240, 255))
    for k in range(4):
        d.rectangle((660, FLOOR - 390 + k * 30, 660 + 120 + (k * 37 % 90), FLOOR - 374 + k * 30), fill=(240, 250, 255, 255))
    d.rectangle((760, FLOOR - 250, 780, FLOOR - 230), fill=(50, 54, 64, 255))
    d.rounded_rectangle((300, FLOOR - 300, 380, FLOOR - 230), 10, fill=(255, 255, 255, 255), outline=(90, 90, 100, 255), width=6)
    d.rectangle((0, FLOOR, W, H), fill=(140, 150, 166, 255))


def set_night(img, d, t):
    _sky(img, (14, 18, 52), (60, 50, 120), FLOOR)
    stars(d, t, 80)
    d.ellipse((780, 180, 940, 340), fill=(255, 244, 200, 255))
    d.ellipse((740, 160, 890, 310), fill=(30, 30, 76, 255))
    rnd = random.Random(5)
    x = -30
    while x < W + 30:
        bw, bh = rnd.randint(90, 170), rnd.randint(200, 520)
        d.rectangle((x, FLOOR - bh, x + bw, FLOOR), fill=(26, 26, 54, 255))
        for wy in range(FLOOR - bh + 20, FLOOR - 20, 40):
            for wx in range(x + 12, x + bw - 20, 30):
                if rnd.random() < 0.35:
                    on = math.sin(t * 0.7 + wx * 0.1 + wy) > -0.8
                    d.rectangle((wx, wy, wx + 14, wy + 18), fill=(255, 220, 120, 255) if on else (50, 50, 80, 255))
        x += bw + rnd.randint(2, 18)
    d.rectangle((0, FLOOR, W, H), fill=(34, 34, 60, 255))


def set_brick(img, d, t):
    wall_scene(img, d, t)


def set_kitchen(img, d, t):
    d.rectangle((0, 0, W, FLOOR), fill=(250, 238, 214, 255))
    for y in range(560, 900, 60):
        for x in range(0, W, 60):
            d.rectangle((x + 2, y + 2, x + 58, y + 58), fill=(236, 246, 246, 255))
    d.rectangle((0, 160, W, 520), fill=(196, 140, 96, 255))
    for x in range(40, W, 260):
        d.rectangle((x, 190, x + 220, 490), fill=(214, 160, 112, 255), outline=(150, 100, 66, 255), width=8)
        d.ellipse((x + 180, 330, x + 196, 346), fill=(120, 80, 50, 255))
    d.rectangle((0, 900, W, 960), fill=(120, 120, 130, 255))
    d.rectangle((0, 960, W, FLOOR), fill=(214, 160, 112, 255))
    d.rectangle((260, 860, 480, 900), fill=(60, 60, 70, 255))
    for k in range(3):
        y = 820 - ((t * 60 + k * 40) % 120)
        d.arc((330 + k * 30, y, 370 + k * 30, y + 40), 90, 270, fill=(255, 255, 255, 180), width=6)
    d.rectangle((0, FLOOR, W, H), fill=(220, 210, 196, 255))
    for x in range(0, W, 120):
        d.line((x, FLOOR, x, H), fill=(200, 190, 176, 255), width=4)


SETS = {'city': set_city, 'room': set_room, 'classroom': set_classroom, 'park': set_park, 'beach': set_beach,
        'office': set_office, 'night': set_night, 'brick': set_brick, 'kitchen': set_kitchen}


def draw_set(name, img, d, t):
    fn = SETS.get(name)
    if not fn:
        return False
    fn(img, d, t)
    return True
