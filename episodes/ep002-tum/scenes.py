"""EP002 — คนชื่อตั้มในไทยมีกี่คน กี่ % ใส่แว่น. Scene code written by Claude; executed by the worker after the timeline is built."""
from engine.core import *
from engine.characters import *
from engine.props import *

TUM = {}  # DEFAULT_STYLE already matches the reference photo

def draw_tum(*a, **k):
    return draw_person(*a, **k)

def tum_icon(size, glasses=True, happy=False):
    return person_icon(size, None, glasses, happy)


# ================================================================ scenes
def sc_hook(img, d, t):
    wall_scene(img, d, t)
    talk = talk_amount(t)
    tg = wt('hook', 'แว่น')
    glint = clamp(1 - abs(t - tg - 0.25) / 0.45) if t > tg - 0.3 else 0
    draw_tum(img, 470, 845, 300, t, pose='sit', mood='shock' if tg <= t < tg + 0.8 else 'normal', glint=glint, phone=True, look=(0.2, 0.0))
    draw_cat(img, 800, 1070, 180, t, mood='normal', talk=talk, look=(-0.6, 0))
    # dark gradient for headline legibility
    d.rectangle((0, 0, W, 560), fill=(20, 12, 20, 130))
    ptext(img, 'คนชื่อตั้มในไทย', 540, 275, 96, t, -0.3)
    ptext(img, 'มีกี่คน?', 540, 385, 86, t, wt('hook', 'มี'), fill=(255, 225, 60))
    tp = wt('hook', 'แล้ว')
    if t >= tp:
        put(img, text_img('กี่ % ใส่แว่น?', 92, 900, (255, 255, 255), 10, (40, 60, 160)), 540, 495, pop(t, tp), 1, -4)


def sc_pop(img, d, t):
    talk = talk_amount(t)
    t0 = SEG['pop']['s']
    tn, tr = wt('pop', 'มี'), wt('pop', 'ตาม')
    t_end = SEG['pop']['phrases'][1]['e']
    u = clamp((t - tn) / (t_end - tn))
    crowd(d, 540, 1010, 960, 360, 220, t, seed=3, frac=0.15 + 0.85 * u)
    val = int(64953661 * (eo(u) if t >= tn else 0))
    rrect(d, (90, 560, 990, 790), 40, (255, 255, 255, 240))
    put(img, text_img(f'{val:,}', 130, 900, (40, 60, 160), 0), 540, 660, 1 + 0.04 * (0 < u < 1) * math.sin(t * 30))
    put(img, text_img('คน', 52, 800, (90, 80, 120), 0), 540, 755, 1)
    if t >= tr:
        put(img, text_img('ทะเบียนราษฎร์ ณ 31 ธ.ค. 2567 (คนสัญชาติไทย)', 40, 700, (255, 255, 255), 6, (30, 30, 70)), 540, 1240, pop(t, tr))
    draw_cat(img, 900, 1310, 150, t, mood='happy', talk=talk)
    draw_tum(img, 180, 1240, 150, t, pose='stand', mood='shock' if t < tr else 'normal')
    headline(img, t, 'คนไทยตอนนี้', t0, 'ราว 65 ล้านคน', tn)


TOP10 = ['ไอซ์', 'แบงค์', 'นิว', 'บอล', 'ต้น', 'เจมส์', 'เฟิร์ส', 'ฟลุ๊ค', 'บิ๊ก', 'เจ']

def sc_nodata(img, d, t):
    talk = talk_amount(t)
    t0 = SEG['nodata']['s']
    tdoc, tx = wt('nodata', 'ชื่อเล่น'), wt('nodata', 'ไม่')
    tlist = wt('nodata', 'แถม')
    tno = wt('nodata', 'มีชื่อ')
    if t < tlist - 0.2:
        # registry document
        s = pop(t, tdoc - 0.1)
        if s > 0:
            lay = Image.new('RGBA', (760, 640), (0, 0, 0, 0))
            dd = ImageDraw.Draw(lay, 'RGBA')
            dd.rounded_rectangle((6, 6, 754, 634), 30, fill=(252, 250, 240, 255), outline=(60, 50, 80, 255), width=8)
            ti = text_img('ข้อมูลในทะเบียนราษฎร์', 50, 800, (60, 50, 80), 0)
            lay.alpha_composite(ti, (380 - ti.width // 2, 30))
            rows = [('ชื่อ', True), ('นามสกุล', True), ('วันเกิด', True), ('ชื่อเล่น', False)]
            for i, (lab, ok) in enumerate(rows):
                y = 150 + i * 115
                dd.rounded_rectangle((40, y, 720, y + 90), 20, fill=(240, 236, 226, 255) if ok else (255, 225, 228, 255))
                ti = text_img(lab, 56, 800, (60, 50, 80), 0)
                lay.alpha_composite(ti, (80, y + 45 - ti.height // 2))
                show = ok or t >= tx
                if show:
                    check(dd, 640, y + 45, 46, ok)
            put(img, lay, 540, 900, s)
        stamp(img, 'ไม่มีช่องนี้!', 760, 1180, t, tx + 0.15, size=80)
        ty = wt('nodata', 'เลย')
        if t >= ty:
            ptext(img, 'นับตั้มจริงๆ ไม่ได้!', 540, 420, 80, t, ty, fill=(255, 225, 60))
        draw_tum(img, 170, 1280, 150, t, pose='stand', mood='think' if t >= ty else 'normal', hand_chin=t >= ty)
    else:
        s = pop(t, tlist - 0.2)
        lay = Image.new('RGBA', (700, 760), (0, 0, 0, 0))
        dd = ImageDraw.Draw(lay, 'RGBA')
        dd.rounded_rectangle((6, 6, 694, 754), 30, fill=(255, 255, 255, 255), outline=(60, 50, 80, 255), width=8)
        ti = text_img('ชื่อเล่นโหล Top 10 (ผู้ชาย)', 44, 800, (60, 50, 80), 0)
        lay.alpha_composite(ti, (350 - ti.width // 2, 24))
        tl1 = SEG['nodata']['phrases'][4]['e']
        n_show = int(clamp((t - tlist) / max(0.3, tl1 - tlist)) * 10) + (1 if t >= tlist else 0)
        for i, nm in enumerate(TOP10[:min(10, n_show)]):
            c, r = divmod(i, 5)
            x, y = 50 + c * 330, 110 + r * 125
            dd.rounded_rectangle((x, y, x + 290, y + 100), 20, fill=(236, 240, 252, 255))
            ti = text_img(f'{i + 1}. {nm}', 50, 800, (40, 60, 160), 0)
            lay.alpha_composite(ti, (x + 20, y + 50 - ti.height // 2))
        put(img, lay, 540, 900, s)
        # magnifier scanning
        if t < tno + 0.3:
            mx = 540 + math.sin(t * 3) * 220
            my = 900 + math.cos(t * 2.3) * 220
            d.ellipse((mx - 70, my - 70, mx + 70, my + 70), outline=(60, 50, 80, 255), width=14)
            d.line((mx + 50, my + 50, mx + 120, my + 120), fill=(60, 50, 80, 255), width=22)
        stamp(img, 'ไม่มี "ตั้ม"!', 540, 1250, t, tno, size=110)
        ptext(img, 'ลิสต์ที่แชร์กันในเน็ต', 540, 420, 76, t, tlist, fill=(255, 225, 60))
        draw_cat(img, 920, 1320, 130, t, mood='worried' if t >= tno else 'normal', talk=talk)
    ptext(img, 'แต่รู้ไหม?', 540, 300, 96, t, t0)


def sc_estimate(img, d, t):
    talk = talk_amount(t)
    t0 = SEG['estimate']['s']
    tg = wt('estimate', 'ถ้า')
    tone = wt('estimate', 'มี')
    tx = wt('estimate', 'ประเทศ')
    tr = wt('estimate', 'ราว')
    stamp(img, 'สมมติ!', 820, 250, t, t0 + 0.1, col=(255, 140, 30), size=100, rot=8)
    if t < tx:
        # 1000 dots
        g = clamp((t - tg) / 0.8)
        cols, rows = 40, 25
        x0, y0, sp = 540 - cols * 22 / 2 + 11, 640, 22
        for i in range(int(1000 * g)):
            r_, c_ = divmod(i, cols)
            x, y = x0 + c_ * sp, y0 + r_ * sp
            hl = (i == 517 and t >= tone)
            if not hl:
                d.ellipse((x - 7, y - 7, x + 7, y + 7), fill=(150, 150, 190, 255))
        if t >= tone:
            s = pop(t, tone)
            x, y = x0 + (517 % cols) * sp, y0 + (517 // cols) * sp
            d.ellipse((x - 20 * s, y - 20 * s, x + 20 * s, y + 20 * s), outline=(255, 225, 60, 255), width=6)
            ic = tum_icon(150)
            put(img, ic, 860, 520 + 30, s)
            arrow(d, 820, 600, x + 14, y - 14, (255, 225, 60, 255), 8, 24)
        if t >= tg:
            put(img, text_img('1,000 คน', 64, 900, (255, 255, 255), 8, (30, 30, 70)), 300, 560, pop(t, tg))
        if t >= tone:
            put(img, text_img('= ตั้ม 1 คน', 64, 900, (255, 225, 60), 8, (30, 30, 70)), 560, 1230, pop(t, tone))
        draw_cat(img, 930, 1320, 120, t, talk=talk, mood='normal')
    else:
        # 65 million / 1000 = 65,000 Tums
        put(img, text_img('65,000,000 ÷ 1,000', 76, 900, (255, 255, 255), 8, (30, 30, 70)), 540, 600, pop(t, tx))
        if t >= tr:
            put(img, text_img('ราว 65,000 ตั้ม', 130, 900, (255, 225, 60), 12, (30, 30, 70)), 540, 760, pop(t, tr), 1, -3)
            rnd = random.Random(8)
            n = int(clamp((t - tr) / 1.2) * 40)
            for i in range(n):
                x = rnd.uniform(110, 970); y = rnd.uniform(880, 1300)
                put(img, tum_icon(90, happy=(i % 3 == 0)), x, y, 1)
        draw_cat(img, 540, 1110 if t < tr else 1320, 200 if t < tr else 120, t, talk=talk, mood='happy')
    ptext(img, 'งั้นลองสมมติ...', 540, 400, 84, t, t0)


def option(img, d, y, letter, label, col, s, dim=1.0, hl=False):
    if s <= 0: return
    lay = Image.new('RGBA', (860, 150), (0, 0, 0, 0))
    dd = ImageDraw.Draw(lay, 'RGBA')
    dd.rounded_rectangle((4, 4, 856, 146), 40, fill=(255, 255, 255, 245), outline=(255, 210, 40, 255) if hl else (50, 30, 80, 255), width=12 if hl else 8)
    dd.ellipse((26, 22, 132, 128), fill=col + (255,))
    li = text_img(letter, 74, 900, (255, 255, 255), 0)
    lay.alpha_composite(li, (79 - li.width // 2, 75 - li.height // 2))
    ti = text_img(label, 80, 900, (50, 30, 80), 0)
    lay.alpha_composite(ti, (170, 75 - ti.height // 2))
    put(img, lay, 540, y, s, dim)


def sc_guess(img, d, t):
    t0 = SEG['guess']['s']
    talk = talk_amount(t)
    rays(d, 540, 900, t, (255, 255, 255, 26))
    tq = wt('guess', 'ผลสำรวจ')
    ta, tb_, tc = wt('guess', 'เอ'), wt('guess', 'บี'), wt('guess', 'ซี')
    t3, t2, t1 = wt('guess', 'สาม'), wt('guess', 'สอง'), wt('guess', 'หนึ่ง')
    dim = 0.35 if t >= t3 else 1.0
    if t >= tq and t < ta:
        rrect(d, (90, 600, 990, 1000), 40, (255, 255, 255, 240))
        put(img, text_img('ผลสำรวจสายตาระดับประเทศ', 52, 800, (90, 80, 120), 0), 540, 670, pop(t, tq))
        tage = wt('guess', 'พบ')
        if t >= tage:
            put(img, text_img('คนไทยอายุ 21–40 ปี', 80, 900, (50, 30, 80), 0), 540, 790, pop(t, tage))
        tpr = wt('guess', 'มีปัญหา')
        if t >= tpr:
            put(img, text_img('มีปัญหาค่าสายตากี่ %?', 72, 900, (230, 60, 90), 0), 540, 910, pop(t, tpr))
    if t >= ta:
        option(img, d, 690, 'A', '10%', (255, 90, 110), pop(t, ta), dim)
        option(img, d, 860, 'B', '25%', (60, 170, 255), pop(t, tb_), dim)
        option(img, d, 1030, 'C', '49%', (60, 190, 140), pop(t, tc), dim)
    for tt, n, nxt in ((t3, '3', t2), (t2, '2', t1), (t1, '1', t1 + 0.6)):
        if tt <= t < nxt:
            u = t - tt
            sc = eob(u / 0.22)
            d.ellipse((540 - 180, 860 - 180, 540 + 180, 860 + 180), fill=(255, 255, 255, 240), outline=(255, 60, 90, 255), width=14)
            put(img, text_img(n, 250, 900, (255, 60, 90), 0), 540, 850, sc)
    draw_tum(img, 200, 1260, 150, t, pose='stand', mood='think', hand_chin=True, look=(0.3, -0.5))
    draw_cat(img, 900, 1300, 150, t, mood='worried', talk=talk, look=(-0.4, -0.3))
    if t < tq:
        sh = math.sin(t * 38) * 6 * clamp(1 - (t - t0) / 0.7)
        put(img, text_img('ทายก่อน!', 150, 900, (255, 230, 60), 12, (60, 20, 90)), 540 + sh, 380, pop(t, t0 + 0.02), 1, -4)
    else:
        ptext(img, 'ทายก่อน!', 540, 300, 96, t, tq, fill=(255, 230, 60), sfill=(60, 20, 90))
        if t >= ta:
            ptext(img, 'คอมเมนต์ A B หรือ C', 540, 420, 70, t, ta, sfill=(60, 20, 90))


def donut(d, cx, cy, R, frac, a=255):
    d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=(225, 228, 240, a))
    if frac > 0:
        d.pieslice((cx - R, cy - R, cx + R, cy + R), -90, -90 + 360 * frac, fill=(60, 190, 140, a))
    r = R * 0.62
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, a))


def sc_reveal(img, d, t):
    t0 = SEG['reveal']['s']
    talk = talk_amount(t)
    confetti(d, t, wt('reveal', 'ซี'), 540, 700)
    tp = wt('reveal', 'สี่')
    trow = wt('reveal', 'แปล')
    if t < trow:
        option(img, d, 640, 'C', '49%', (60, 190, 140), 1.0, 1.0, True)
        f = 0.49 * eo((t - tp) / 0.9) if t >= tp else 0
        donut(d, 540, 1000, 230, f)
        put(img, text_img(f'{int(round(f * 100))}%', 110, 900, (40, 150, 110), 0), 540, 990, 1)
        tk = wt('reveal', 'เกือบ')
        if t >= tk:
            stamp(img, 'เกือบครึ่ง!', 820, 1150, t, tk, col=(40, 150, 110), size=90)
        draw_cat(img, 170, 1150, 140, t, mood='happy', talk=talk)
    else:
        # 10 Tums, about half with glasses
        tg = wt('reveal', 'พึ่ง')
        put(img, text_img('ตั้มวัยทำงาน 10 คน', 64, 900, (255, 255, 255), 8, (30, 30, 70)), 540, 640, pop(t, trow))
        glassed = {0, 2, 4, 7, 9}
        for i in range(10):
            r_, c_ = divmod(i, 5)
            x, y = 150 + c_ * 195, 820 + r_ * 240
            s = pop(t, trow + 0.06 * i)
            has = i in glassed and t >= tg - 0.6 + 0.08 * i
            if s > 0:
                put(img, tum_icon(170, glasses=has, happy=has), x, y, s)
        if t >= tg:
            put(img, text_img('ราว 5 ใน 10 อาจต้องพึ่งแว่น', 64, 900, (255, 225, 60), 8, (30, 30, 70)), 540, 1215, pop(t, tg))
    put(img, text_img('ผลสำรวจสายตาระดับชาติ ปี 2549 • อายุ 21–40 ปี', 34, 700, (255, 255, 255), 5, (30, 30, 70)), 540, 1300, 1)
    put(img, text_img('เฉลย C!', 140, 900, (255, 230, 60), 12, (20, 60, 90)), 540, 360, pop(t, t0 + 0.02), 1, -4)


def sc_myth(img, d, t):
    t0 = SEG['myth']['s']
    talk = talk_amount(t)
    tm, tn = wt('myth', 'ใส่'), wt('myth', 'ไม่')
    tre = wt('myth', 'ค่า')
    tok = wt('myth', 'ไม่', 1)
    tm2 = wt('myth', 'ส่วน')
    tn2 = wt('myth', 'ก็')
    if t < tm2:
        rrect(d, (90, 560, 990, 760), 40, (255, 255, 255, 240))
        put(img, text_img('ความเชื่อ:', 44, 800, (120, 100, 140), 0), 540, 600, 1)
        if t >= tm:
            put(img, text_img('ใส่แว่นแล้ว สายตาแย่ลง?', 70, 900, (50, 30, 80), 0), 540, 685, pop(t, tm))
        stamp(img, 'ไม่จริง!', 800, 820, t, tn, size=110)
        if t >= tre:
            for i, (lab, tt) in enumerate((('เปลี่ยนตามอายุ', tre), ('ภาวะสายตาที่เป็นอยู่', wt('myth', 'หรือ')))):
                if t >= tt:
                    y = 960 + i * 120
                    s = pop(t, tt)
                    rrect(d, (180, y - 48, 900, y + 48), 30, (230, 245, 238, 255))
                    put(img, text_img(lab, 58, 800, (30, 110, 80), 0), 560, y, s)
                    check(d, 240, y, 46, True)
            if t >= tok:
                put(img, text_img('ไม่ใช่เพราะแว่น', 72, 900, (255, 255, 255), 8, (30, 110, 80)), 540, 1230, pop(t, tok))
        draw_tum(img, 160, 1300, 140, t, pose='stand', mood='shock' if tn <= t < tre else 'normal', glint=clamp(1 - abs(t - tok - 0.3) / 0.5))
    else:
        rrect(d, (90, 560, 990, 860), 40, (255, 255, 255, 240))
        put(img, text_img('ความเชื่อที่ 2:', 44, 800, (120, 100, 140), 0), 540, 600, 1)
        put(img, text_img('ตัดแว่นให้อ่อนกว่าค่าจริง', 66, 900, (50, 30, 80), 0), 540, 690, pop(t, tm2))
        put(img, text_img('ช่วยชะลอสายตาสั้น?', 66, 900, (50, 30, 80), 0), 540, 790, pop(t, tm2 + 0.4))
        if t >= tn2:
            check(d, 540, 1010, 150, False)
            put(img, text_img('ไม่ได้ช่วย', 90, 900, (235, 60, 80), 8, (255, 255, 255)), 540, 1170, pop(t, tn2 + 0.2))
        draw_tum(img, 170, 1300, 140, t, pose='stand', mood='think', hand_chin=True)
    draw_cat(img, 910, 1310, 140, t, mood='happy' if t >= tn else 'worried', talk=talk)
    ptext(img, 'ความเชื่อผิด!', 540, 330, 104, t, t0, fill=(255, 90, 110), sfill=(255, 255, 255))


def globe(img, d, cx, cy, R, t, half):
    d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=(70, 150, 230, 255), outline=(30, 40, 90, 255), width=10)
    rnd = random.Random(12)
    for i in range(9):
        lon = (rnd.uniform(0, 2 * math.pi) + t * 0.6) % (2 * math.pi)
        lat = rnd.uniform(-0.9, 0.9)
        if math.cos(lon) < 0: continue
        x = cx + R * math.sin(lon) * math.cos(lat)
        y = cy + R * math.sin(lat)
        rr = R * rnd.uniform(0.12, 0.25) * math.cos(lon) ** 0.5
        d.ellipse((x - rr, y - rr * 0.7, x + rr, y + rr * 0.7), fill=(110, 200, 120, 255))
    if half > 0:
        d.pieslice((cx - R, cy - R, cx + R, cy + R), 90, 90 + 180 * half, fill=(40, 30, 70, 150))


def sc_world(img, d, t):
    t0 = SEG['world']['s']
    talk = talk_amount(t)
    stars(d, t, 40)
    ty = wt('world', 'ปี')
    th = wt('world', 'คน')
    tph = wt('world', 'เพราะ')
    tsun = wt('world', 'และ')
    half = clamp((t - th) / 0.8) if t >= th else 0
    globe(img, d, 540, 900, 300, t, half)
    if t >= th:
        put(img, text_img('สายตาสั้น ~50%', 64, 900, (255, 255, 255), 8, (40, 30, 70)), 540, 1250, pop(t, th))
    if t >= tph:
        s = pop(t, tph)
        # phone icon = near work
        x, y = 200, 700
        d.rounded_rectangle((x - 55 * s, y - 95 * s, x + 55 * s, y + 95 * s), int(18 * s), fill=(40, 40, 50, 255), outline=(255, 255, 255, 255), width=6)
        d.rectangle((x - 42 * s, y - 75 * s, x + 42 * s, y + 70 * s), fill=(120, 190, 255, 255))
        put(img, text_img('ใช้สายตาใกล้มากขึ้น', 40, 800, (255, 255, 255), 6, (40, 30, 70)), x + 60, y + 140, s)
    if t >= tsun:
        s = pop(t, tsun)
        x, y = 920, 700
        for k2 in range(8):
            a = k2 * math.pi / 4 + t
            d.line((x + 60 * s * math.cos(a), y + 60 * s * math.sin(a), x + 90 * s * math.cos(a), y + 90 * s * math.sin(a)), fill=(255, 200, 60, 255), width=10)
        d.ellipse((x - 48 * s, y - 48 * s, x + 48 * s, y + 48 * s), fill=(255, 210, 60, 255))
        put(img, text_img('เจอแดดน้อยลง', 40, 800, (255, 255, 255), 6, (40, 30, 70)), x - 40, y + 140, s)
    draw_cat(img, 860, 1290, 150, t, mood='shock' if t >= th else 'normal', talk=talk)
    put(img, text_img('Holden et al., Ophthalmology 2016', 32, 600, (220, 220, 240), 0), 540, 505, 1)
    ptext(img, 'นักวิจัยคาดว่า...', 540, 300, 90, t, t0)
    if t >= ty:
        ptext(img, 'ปี ค.ศ. 2050 ครึ่งโลกสายตาสั้น', 540, 420, 70, t, ty, fill=(255, 225, 60))


def sc_close(img, d, t):
    t0 = SEG['close']['s']
    talk = talk_amount(t)
    wall_scene(img, d, t)
    tw = wt('close', 'ใคร')
    tc = wt('close', 'คอมเมนต์')
    draw_tum(img, 470, 845, 300, t, pose='sit', mood='happy', wave=1.0 if t >= t0 + 0.3 else 0.0)
    draw_cat(img, 800, 1070, 180, t, mood='happy', talk=talk, look=(-0.5, 0))
    d.rectangle((0, 0, W, 480), fill=(20, 12, 20, 130))
    ptext(img, 'สถิติคนต่อไป', 540, 300, 96, t, t0)
    ptext(img, 'ชื่ออะไรดี?', 540, 420, 86, t, tw, fill=(255, 225, 60))
    names = ['บอล?', 'นิว?', 'แบงค์?', 'ต้น?', 'มายด์?', 'พลอย?']
    if tw <= t < tc:
        for i, nm in enumerate(names):
            ang = t * 0.8 + i * math.pi / 3
            x = 540 + math.cos(ang) * 400
            y = 590 + math.sin(ang) * 55
            put(img, text_img(nm, 50, 800, (50, 30, 80), 6, (255, 255, 255)), x, y, pop(t, tw + 0.1 * i))
    if t >= tc:
        s = pop(t, tc)
        bob = math.sin(t * 6) * 8
        comment_icon(d, 880, 620 + bob, 1.0 * s)
        put(img, text_img('พิมพ์ชื่อเพื่อน', 64, 900, (255, 255, 255), 8, (120, 40, 70)), 400, 600, s)
        put(img, text_img('ใต้คอมเมนต์ได้เลย!', 56, 900, (255, 225, 60), 8, (120, 40, 70)), 400, 680, s)


SCENES = {
    'hook': (sc_hook, ((40, 20, 30), (40, 20, 30))),
    'pop': (sc_pop, ((60, 90, 200), (150, 120, 230))),
    'nodata': (sc_nodata, ((90, 60, 160), (200, 110, 170))),
    'estimate': (sc_estimate, ((30, 120, 150), (90, 190, 190))),
    'guess': (sc_guess, ((110, 50, 200), (230, 90, 170))),
    'reveal': (sc_reveal, ((30, 110, 160), (90, 200, 200))),
    'myth': (sc_myth, ((60, 30, 90), (180, 70, 110))),
    'world': (sc_world, ((10, 15, 50), (40, 50, 120))),
    'close': (sc_close, ((40, 20, 30), (40, 20, 30))),
}


