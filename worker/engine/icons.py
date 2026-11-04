"""Code-written SVG icon set (100x100 viewBox, flat fills, dark outline). No images or fonts involved."""
import re
from .core import svg_img

_S = 'stroke="#1E1632" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"'
_K = '#1E1632'

_ICONS = {
    'question': '<circle cx="50" cy="50" r="42" fill="#FFD43B" S/><path d="M37 39a13 13 0 1 1 19 11c-5 3-6 6-6 11" fill="none" S stroke-width="9"/><circle cx="50" cy="75" r="6" fill="K"/>',
    'exclaim': '<circle cx="50" cy="50" r="42" fill="#FF6B6B" S/><path d="M50 24v34" S stroke="#fff" stroke-width="11"/><circle cx="50" cy="74" r="6.5" fill="#fff"/>',
    'money': '<rect x="8" y="26" width="84" height="50" rx="9" fill="#5FD08A" S/><circle cx="50" cy="51" r="14" fill="#DFFFE9" S/><circle cx="22" cy="51" r="4" fill="K"/><circle cx="78" cy="51" r="4" fill="K"/>',
    'coin': '<ellipse cx="50" cy="72" rx="34" ry="12" fill="#E6A817" S/><rect x="16" y="52" width="68" height="20" fill="#F5C542" stroke="none"/><path d="M16 52v20M84 52v20" S/><ellipse cx="50" cy="52" rx="34" ry="12" fill="#FFD95A" S/><rect x="16" y="32" width="68" height="20" fill="#F5C542" stroke="none"/><path d="M16 32v20M84 32v20" S/><ellipse cx="50" cy="32" rx="34" ry="12" fill="#FFE27A" S/>',
    'clock': '<circle cx="50" cy="50" r="42" fill="#fff" S/><path d="M50 22v29l18 11" fill="none" S stroke-width="8"/><circle cx="50" cy="50" r="4" fill="K"/>',
    'globe': '<circle cx="50" cy="50" r="42" fill="#5CB8FF" S/><path d="M28 30c10 4 14 12 8 20s4 16-2 22M62 14c-6 8 2 14 10 16s10 12 2 18-4 16 4 20" fill="#6BD58A" S stroke-width="5"/><circle cx="50" cy="50" r="42" fill="none" S/>',
    'house': '<path d="M14 50 50 18l36 32" fill="none" S stroke-width="8"/><path d="M24 44v42h52V44L50 22z" fill="#FFE3B3" S/><path d="M14 50 50 18l36 32" fill="none" stroke="#E2574C" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><rect x="42" y="60" width="16" height="26" rx="3" fill="#8A5A3C" S/>',
    'car': '<path d="M14 64v-12l10-4 10-14h32l12 14 10 4v12z" fill="#FF6B6B" S/><path d="M38 38h12v10H30zM56 38h8l8 10H56z" fill="#CDEBFF" S stroke-width="4"/><circle cx="30" cy="68" r="10" fill="#3A3550" S/><circle cx="70" cy="68" r="10" fill="#3A3550" S/>',
    'phone': '<rect x="27" y="8" width="46" height="84" rx="9" fill="#3A3550" S/><rect x="33" y="18" width="34" height="58" rx="4" fill="#7FD3FF"/><circle cx="50" cy="84" r="3.5" fill="#fff"/>',
    'food': '<path d="M12 50h76c0 22-16 36-38 36S12 72 12 50z" fill="#FF9F5A" S/><path d="M30 40c-4-6 4-10 0-16M50 40c-4-6 4-10 0-16M70 40c-4-6 4-10 0-16" fill="none" S stroke-width="5"/><path d="M62 30 90 12M68 36 94 20" S stroke="#8A5A3C" stroke-width="5"/>',
    'book': '<path d="M50 26C38 18 22 18 10 22v56c12-4 28-4 40 4z" fill="#FFF3D6" S/><path d="M50 26c12-8 28-8 40-4v56c-12-4-28-4-40 4z" fill="#FFE2A8" S/><path d="M50 26v56" S/>',
    'chart': '<path d="M14 86h74" S/><rect x="20" y="58" width="16" height="26" rx="2" fill="#5CB8FF" S stroke-width="5"/><rect x="42" y="42" width="16" height="42" rx="2" fill="#6BD58A" S stroke-width="5"/><rect x="64" y="20" width="16" height="64" rx="2" fill="#FFD43B" S stroke-width="5"/>',
    'chart_down': '<path d="M14 86h74" S/><rect x="20" y="22" width="16" height="62" rx="2" fill="#FFD43B" S stroke-width="5"/><rect x="42" y="44" width="16" height="40" rx="2" fill="#FF9F5A" S stroke-width="5"/><rect x="64" y="62" width="16" height="22" rx="2" fill="#FF6B6B" S stroke-width="5"/>',
    'up': '<circle cx="50" cy="50" r="42" fill="#6BD58A" S/><path d="M50 74V28M30 46l20-20 20 20" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>',
    'down': '<circle cx="50" cy="50" r="42" fill="#FF6B6B" S/><path d="M50 26v46M30 54l20 20 20-20" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>',
    'warning': '<path d="M50 10 92 86H8z" fill="#FFD43B" S/><path d="M50 36v24" S stroke-width="10"/><circle cx="50" cy="72" r="5.5" fill="K"/>',
    'check': '<circle cx="50" cy="50" r="42" fill="#3DBE7A" S/><path d="M30 52l14 14 28-30" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>',
    'cross': '<circle cx="50" cy="50" r="42" fill="#EB4F5F" S/><path d="M34 34l32 32M66 34 34 66" stroke="#fff" stroke-width="11" stroke-linecap="round"/>',
    'star': '<path d="M50 8l12 26 28 3-21 19 6 28-25-14-25 14 6-28L10 37l28-3z" fill="#FFD43B" S/>',
    'fire': '<path d="M50 92c-20 0-32-14-30-32 2-16 14-22 14-40 12 8 18 18 18 28 4-4 6-10 6-16 12 10 22 22 22 32 0 16-12 28-30 28z" fill="#FF7A3C" S/><path d="M50 90c-9 0-15-6-14-15 1-8 8-11 9-20 8 6 15 12 15 21 0 8-4 14-10 14z" fill="#FFD43B"/>',
    'water': '<path d="M50 8C38 30 22 46 22 62a28 28 0 0 0 56 0c0-16-16-32-28-54z" fill="#5CB8FF" S/><path d="M36 64a14 14 0 0 0 12 14" fill="none" stroke="#DDF2FF" stroke-width="7" stroke-linecap="round"/>',
    'bolt': '<path d="M58 6 22 56h24l-8 38 40-54H54z" fill="#FFD43B" S/>',
    'people': '<circle cx="34" cy="34" r="13" fill="#FFCBA4" S/><path d="M12 86c0-18 10-30 22-30s22 12 22 30z" fill="#5CB8FF" S/><circle cx="66" cy="30" r="14" fill="#FFCBA4" S/><path d="M42 86c0-20 11-34 24-34s24 14 24 34z" fill="#FF6B6B" S/>',
    'person': '<circle cx="50" cy="30" r="17" fill="#FFCBA4" S/><path d="M20 90c0-24 13-40 30-40s30 16 30 40z" fill="#7C6CF2" S/>',
    'trophy': '<path d="M30 14h40v20c0 14-8 24-20 24S30 48 30 34z" fill="#FFD43B" S/><path d="M30 22H16c0 14 6 20 16 20M70 22h14c0 14-6 20-16 20" fill="none" S/><path d="M44 58h12v14H44z" fill="#E6A817" S stroke-width="5"/><rect x="30" y="72" width="40" height="14" rx="3" fill="#8A5A3C" S/>',
    'calendar': '<rect x="12" y="18" width="76" height="70" rx="9" fill="#fff" S/><path d="M12 27a9 9 0 0 1 9-9h58a9 9 0 0 1 9 9v13H12z" fill="#EB4F5F" S/><path d="M32 10v16M68 10v16" S stroke-width="8"/><circle cx="32" cy="56" r="5" fill="K"/><circle cx="50" cy="56" r="5" fill="K"/><circle cx="68" cy="56" r="5" fill="K"/><circle cx="32" cy="72" r="5" fill="K"/><circle cx="50" cy="72" r="5" fill="#EB4F5F"/>',
    'pin': '<path d="M50 94S20 60 20 38a30 30 0 0 1 60 0c0 22-30 56-30 56z" fill="#EB4F5F" S/><circle cx="50" cy="38" r="11" fill="#fff" S stroke-width="5"/>',
    'bulb': '<path d="M50 8a28 28 0 0 0-16 51c3 3 5 7 5 12h22c0-5 2-9 5-12A28 28 0 0 0 50 8z" fill="#FFE45C" S/><rect x="38" y="72" width="24" height="16" rx="4" fill="#B7B3C9" S stroke-width="5"/><path d="M44 52l6-10 6 10" fill="none" S stroke-width="4"/>',
    'eye': '<path d="M6 50c12-20 28-30 44-30s32 10 44 30c-12 20-28 30-44 30S18 70 6 50z" fill="#fff" S/><circle cx="50" cy="50" r="17" fill="#5CB8FF" S/><circle cx="50" cy="50" r="7" fill="K"/><circle cx="56" cy="44" r="4" fill="#fff"/>',
    'heart': '<path d="M50 88S10 62 10 36a20 20 0 0 1 40-6 20 20 0 0 1 40 6c0 26-40 52-40 52z" fill="#FF5C7A" S/>',
    'sun': '<circle cx="50" cy="50" r="22" fill="#FFD43B" S/><path d="M50 8v12M50 80v12M8 50h12M80 50h12M20 20l9 9M71 71l9 9M80 20l-9 9M29 71l-9 9" S stroke="#FF9F1C" stroke-width="7"/>',
    'moon': '<path d="M62 10a40 40 0 1 0 28 62A34 34 0 0 1 62 10z" fill="#FFE27A" S/>',
    'sleep': '<path d="M58 14a36 36 0 1 0 26 56A30 30 0 0 1 58 14z" fill="#B9A8FF" S/><path d="M62 18h20L62 40h20" fill="none" S stroke-width="5"/>',
    'tree': '<rect x="42" y="58" width="16" height="32" rx="3" fill="#8A5A3C" S/><circle cx="50" cy="40" r="30" fill="#4CC07A" S/><circle cx="38" cy="34" r="6" fill="#8BE3A8"/>',
    'plane': '<path d="M50 6c5 0 7 6 7 14v18l35 20v10L57 58v18l12 9v8l-19-6-19 6v-8l12-9V58L8 68V58l35-20V20c0-8 2-14 7-14z" fill="#E9F3FF" S/>',
    'school': '<path d="M50 18 6 38l44 20 44-20z" fill="#3A3550" S/><path d="M26 48v20c0 8 12 14 24 14s24-6 24-14V48L50 58z" fill="#5A5375" S/><path d="M90 40v26" S stroke-width="5"/><circle cx="90" cy="70" r="5" fill="#FFD43B" S stroke-width="3"/>',
    'health': '<circle cx="50" cy="50" r="42" fill="#fff" S/><path d="M42 24h16v18h18v16H58v18H42V58H24V42h18z" fill="#EB4F5F" S stroke-width="4"/>',
    'cart': '<path d="M8 16h14l12 50h44l10-34H26" fill="none" S stroke-width="7"/><path d="M28 32h56l-8 28H34z" fill="#FFD43B" stroke="none"/><path d="M8 16h14l12 50h44l10-34H26" fill="none" S stroke-width="7"/><circle cx="38" cy="82" r="7" fill="K"/><circle cx="74" cy="82" r="7" fill="K"/>',
    'game': '<path d="M24 32h52c12 0 18 10 18 26 0 14-6 24-14 24-8 0-12-10-18-10H38c-6 0-10 10-18 10-8 0-14-10-14-24 0-16 6-26 18-26z" fill="#7C6CF2" S/><path d="M28 46v16M20 54h16" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="68" cy="48" r="5" fill="#FFD43B"/><circle cx="76" cy="58" r="5" fill="#FF6B6B"/>',
    'music': '<path d="M38 72V22l44-10v48" fill="none" S stroke-width="8"/><ellipse cx="28" cy="74" rx="13" ry="10" fill="#7C6CF2" S/><ellipse cx="72" cy="62" rx="13" ry="10" fill="#7C6CF2" S/>',
    'coffee': '<path d="M18 38h54v24c0 14-10 24-27 24S18 76 18 62z" fill="#fff" S/><path d="M72 44h6a10 10 0 0 1 0 20h-6" fill="none" S/><path d="M22 46h46v14c0 10-8 18-23 18S22 70 22 60z" fill="#8A5A3C"/><path d="M34 26c-3-5 3-8 0-14M50 26c-3-5 3-8 0-14" fill="none" S stroke-width="5"/>',
    'thai_flag': '<rect x="6" y="20" width="88" height="60" rx="6" fill="#ED1C24" S/><rect x="9" y="30" width="82" height="40" fill="#fff"/><rect x="9" y="40" width="82" height="20" fill="#241D4F"/><rect x="6" y="20" width="88" height="60" rx="6" fill="none" S/>',
    'fitness': '<rect x="6" y="36" width="12" height="28" rx="3" fill="#3A3550" S stroke-width="4"/><rect x="18" y="28" width="12" height="44" rx="3" fill="#5A5375" S stroke-width="4"/><rect x="70" y="28" width="12" height="44" rx="3" fill="#5A5375" S stroke-width="4"/><rect x="82" y="36" width="12" height="28" rx="3" fill="#3A3550" S stroke-width="4"/><path d="M30 50h40" S stroke-width="9"/>',
    'battery': '<rect x="8" y="28" width="76" height="44" rx="8" fill="#fff" S/><rect x="84" y="40" width="8" height="20" rx="2" fill="K"/><rect x="16" y="36" width="20" height="28" rx="3" fill="#EB4F5F"/>',
    'wifi': '<path d="M12 40a54 54 0 0 1 76 0M24 54a36 36 0 0 1 52 0M36 68a18 18 0 0 1 28 0" fill="none" S stroke-width="9"/><circle cx="50" cy="80" r="7" fill="K"/>',
    'trash': '<path d="M22 28h56l-6 60H28z" fill="#B7B3C9" S/><path d="M14 28h72M40 18h20" S stroke-width="8"/><path d="M40 42v34M60 42v34" S stroke-width="5"/>',
    'hot': '<rect x="38" y="8" width="24" height="60" rx="12" fill="#fff" S/><circle cx="50" cy="74" r="18" fill="#EB4F5F" S/><path d="M50 36v34" stroke="#EB4F5F" stroke-width="10" stroke-linecap="round"/>',
    'rain': '<path d="M26 58a18 18 0 0 1 2-36 24 24 0 0 1 44 6 15 15 0 0 1 2 30z" fill="#DDE6F5" S/><path d="M34 70l-6 14M52 70l-6 14M70 70l-6 14" stroke="#5CB8FF" stroke-width="7" stroke-linecap="round"/>',
    'cat': '<path d="M20 40 24 12l18 16h16l18-16 4 28c6 8 8 16 8 22 0 18-18 28-38 28S12 80 12 62c0-6 2-14 8-22z" fill="#78E2CC" S/><circle cx="38" cy="56" r="5" fill="K"/><circle cx="62" cy="56" r="5" fill="K"/><path d="M44 68q6 6 12 0" fill="none" S stroke-width="4"/>',
    'baby': '<circle cx="50" cy="46" r="34" fill="#FFCBA4" S/><path d="M44 14c4 6 12 6 14 0" fill="none" S stroke-width="5"/><circle cx="38" cy="46" r="4" fill="K"/><circle cx="62" cy="46" r="4" fill="K"/><ellipse cx="50" cy="64" rx="9" ry="6" fill="#FF8FA3" S stroke-width="4"/>',
    'brain': '<path d="M50 18c-6-8-22-6-24 6-12 0-18 14-10 22-8 8-2 22 10 22 2 10 16 14 24 6 8 8 22 4 24-6 12 0 18-14 10-22 8-8 2-22-10-22-2-12-18-14-24-6z" fill="#FFB3C7" S/><path d="M50 18v56M36 34c6 2 8 8 6 14M64 34c-6 2-8 8-6 14M30 56c6-2 10 0 12 6M70 56c-6-2-10 0-12 6" fill="none" S stroke-width="4"/>',
}

NAMES = sorted(_ICONS)
_TAG = re.compile(r'<(\w+)([^<>]*?)(/?)>')
_ATTR = re.compile(r'([\w:-]+)="([^"]*)"')


def _expand(body):
    """Expand the S shorthand into stroke attributes; an element's own attributes win (no duplicate attributes)."""
    def fix(m):
        tag, attrs, close = m.groups()
        attrs = attrs.replace(' S', ' ' + _S) if attrs.endswith(' S') or ' S ' in attrs else attrs
        seen = {}
        for k, v in _ATTR.findall(attrs):
            seen.pop(k, None)
            seen[k] = v
        # values given explicitly after S override the defaults: keep the last occurrence of each attribute
        return '<' + tag + ''.join(f' {k}="{v}"' for k, v in seen.items()) + close + '>'
    return _TAG.sub(fix, body.replace('"K"', f'"{_K}"'))


def icon(name, size=160):
    """Rasterised icon (falls back to the question mark for unknown names)."""
    body = _expand(_ICONS.get(name) or _ICONS['question'])
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 108 108" width="{size}" height="{size}">{body}</svg>'
    return svg_img(svg, size, size)
