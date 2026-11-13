"""Bundle trusted fonts and clean up the legacy scene text helper without an LLM call."""
import base64, re
from pathlib import Path
from engine.core import FD

VERSION = 'all-text-kanit-v1'
MARKER = 'motion-trusted-typography'


def prepare_source(html):
    if MARKER in html:
        raise ValueError('Source already contains a typography runtime; use its original source')
    js = Path(__file__).with_suffix('.js').read_text()
    for weight in (700, 800):
        js = js.replace(f'__KANIT_{weight}__', base64.b64encode((Path(FD)/f'Kanit-{weight}.ttf').read_bytes()).decode())
    licence = (Path(FD)/'OFL-Kanit.txt').read_text().replace('--', '—')
    css = '*{font-family:"Motion Kanit",sans-serif!important;font-synthesis:none!important;text-shadow:none!important}canvas{image-rendering:auto!important}'
    payload = f'<meta charset="utf-8"><!-- Bundled Kanit font licence:\n{licence}\n--><style>{css}</style><script id="{MARKER}">{js}</script>'
    head = re.search(r'<head\b[^>]*>', html, re.I)
    if not head: raise ValueError('Scene must have an HTML head for trusted typography')
    result = html[:head.end()] + payload + html[head.end():]
    if len(result) > 600000 or len(result.encode()) > 750000:
        raise ValueError('Scene plus trusted fonts exceeds renderer input limit')
    return result


def repair_source(html):
    # This is the old generated helper contract, not an arbitrary JavaScript rewrite.
    # Unsupported sources fail visibly rather than claiming a partial text repair.
    pattern = r'^function text\(s,x,y,size,fill=I,stroke=null,max=1000\)\{[^\n]*\}$'
    replacement = 'function text(s,x,y,size,fill=I,stroke=null,max=1000){MotionText.draw(c,s,x,y,size>=72?Math.max(108,size):Math.max(48,size),stroke||fill,null,max)}'
    html, count = re.subn(pattern, replacement, html, flags=re.M)
    if count != 1:
        if 'MotionText.draw(' not in html: raise ValueError('Unsupported scene text helper; review source before typography repair')
    # Remove the offset copy of a headline, preserving its actual text and final position.
    duplicate = r"text\((?P<text>'[^'\n]*'|\"[^\"\n]*\"),(?P<x1>\d+),(?P<y1>\d+),(?P<size>\d+),\w+,(?P<stroke>\w+),(?P<width>\d+)\);(?P<front>text\((?P=text),(?P<x2>\d+),(?P<y2>\d+),(?P=size),\w+,(?P=stroke),(?P=width)\);)"
    def clean(match):
        if abs(int(match['x1'])-int(match['x2'])) <= 16 and abs(int(match['y1'])-int(match['y2'])) <= 16:
            return match['front']
        return match[0]
    return re.sub(duplicate, clean, html)
