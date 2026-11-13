"""Trusted portrait captions. ASS coordinates and bundled font never depend on SRT defaults."""
from pathlib import Path
import os
import shutil
import subprocess
from PIL import ImageFont
from engine.core import FD

VERSION = 'kanit-portrait-v2'
FONT = Path(FD) / 'Kanit-800.ttf'
WIDTH, HEIGHT, CENTER_Y = 1080, 1920, 1660
TEXT_SIZE, MAX_WIDTH, LINE_HEIGHT = 74, 880, 100


def literal(text):
    # Narration is text, never ASS override code or an injected dialogue line.
    return str(text).replace('\\', '＼').replace('{', '｛').replace('}', '｝').replace('\r', ' ').replace('\n', ' ')


def timestamp(t):
    n = max(0, round(t * 100))
    return f'{n // 360000}:{n // 6000 % 60:02}:{n // 100 % 60:02}.{n % 100:02}'


def pages(words, font):
    """Wrap at actual Thai word boundaries; long narration advances in two-line pages."""
    lines, line = [], []
    for word in words:
        if font.getlength(literal(word['w'])) > MAX_WIDTH:
            raise ValueError('Caption token exceeds portrait safe width; split the narration token first')
        if line and font.getlength(''.join(literal(w['w']) for w in [*line, word])) > MAX_WIDTH:
            lines.append(line); line = []
        line.append(word)
    if line: lines.append(line)
    return [lines[i:i + 2] for i in range(0, len(lines), 2)]


def rounded_box(left, top, right, bottom, radius=24):
    # Native-resolution vector plate; no blur and no stretched bitmap lettering.
    r = radius; k = round(r * .5523)
    return (f'm {left+r} {top} l {right-r} {top} '
            f'b {right-r+k} {top} {right} {top+r-k} {right} {top+r} '
            f'l {right} {bottom-r} b {right} {bottom-r+k} {right-r+k} {bottom} {right-r} {bottom} '
            f'l {left+r} {bottom} b {left+r-k} {bottom} {left} {bottom-r+k} {left} {bottom-r} '
            f'l {left} {top+r} b {left} {top+r-k} {left+r-k} {top} {left+r} {top}')


def ass(timing):
    font = ImageFont.truetype(str(FONT), TEXT_SIZE)
    # libass sizes by ascender+descender, Pillow/Classic by em. Match Classic's 74px em.
    ass_size = sum(font.getmetrics())
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Kanit ExtraBold,{ass_size},&H00FFFFFF,&H00FFFFFF,&H001E0A14,&H00000000,0,0,0,0,100,100,0,0,1,3,0,5,100,100,160,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    events = []
    def event(layer, start, end, text):
        if timestamp(start) != timestamp(end):
            events.append(f'Dialogue: {layer},{timestamp(start)},{timestamp(end)},Caption,,0,0,0,,{text}')
    phrases = [p for s in timing['timeline'] for p in s['phrases']]
    for i, phrase in enumerate(phrases):
        stop = min(phrases[i+1]['s'] if i+1 < len(phrases) else timing['end'], phrase['e'] + .9)
        groups = pages(phrase['words'], font)
        for j, lines in enumerate(groups):
            start = lines[0][0]['s']
            end = groups[j+1][0][0]['s'] if j+1 < len(groups) else stop
            if end <= start: continue
            width = max(font.getlength(''.join(literal(w['w']) for w in line)) for line in lines)
            half_h = (LINE_HEIGHT * len(lines) + 36) // 2
            box = rounded_box(round(540-width/2-28), CENTER_Y-half_h, round(540+width/2+28), CENTER_Y+half_h)
            event(0, start, end, r'{\an7\pos(0,0)\bord0\shad0\1c&H1E0A0F&\1a&H55&\p1}' + box)
            changes = sorted({start, end, *(w['s'] for line in lines for w in line if start < w['s'] < end)})
            for a, b in zip(changes, changes[1:]):
                for n, line in enumerate(lines):
                    y = CENTER_Y + (n - (len(lines)-1)/2) * LINE_HEIGHT
                    text = ''.join((r'{\1c&H28DEFF&}' if w['s'] <= a else r'{\1c&HFFFFFF&}') + literal(w['w']) for w in line)
                    event(1, a, b, f'{{\\an5\\pos(540,{y:g})}}' + text)
    return header + '\n'.join(events) + '\n'


def burn(raw, timing, folder):
    folder = Path(folder); folder.mkdir(parents=True, exist_ok=True)
    fonts = folder / 'caption-fonts'; fonts.mkdir(exist_ok=True)
    cache = folder.resolve() / 'font-cache'; cache.mkdir(exist_ok=True)
    shutil.copyfile(FONT, fonts / FONT.name)  # fail loudly if the bundled font is missing
    (folder / 'subtitles.ass').write_text(ass(timing), encoding='utf-8')
    output = folder / 'video_silent.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-filter_threads', '2', '-i', str(Path(raw).resolve()),
                    '-vf', 'setsar=1,ass=subtitles.ass:fontsdir=caption-fonts', '-an', '-c:v', 'libx264',
                    '-threads', '2', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
                    str(output.resolve())], cwd=folder, env={**os.environ, 'XDG_CACHE_HOME':str(cache)}, check=True, timeout=600)
    return str(output)
