"""Built-in ~10 s acceptance-test episode: SVG character + movement + Thai narration + highlighted subtitles + SFX + music."""

SCENE_CODE = r'''
from engine.core import *

def svg_cat(mood):
    mouth = '<path d="M86 118 Q100 132 114 118" stroke="#2a1e32" stroke-width="5" fill="none" stroke-linecap="round"/>' if mood == 'happy' \
        else '<ellipse cx="100" cy="122" rx="10" ry="12" fill="#7a2440"/>'
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <path d="M40 70 L55 20 L85 55 Z" fill="#78e2cc" stroke="#22806f" stroke-width="5" stroke-linejoin="round"/>
  <path d="M160 70 L145 20 L115 55 Z" fill="#78e2cc" stroke="#22806f" stroke-width="5" stroke-linejoin="round"/>
  <ellipse cx="100" cy="110" rx="78" ry="66" fill="#78e2cc" stroke="#22806f" stroke-width="6"/>
  <ellipse cx="72" cy="80" rx="14" ry="7" fill="#ffffff" opacity="0.8"/>
  <circle cx="74" cy="100" r="9" fill="#2a1e32"/><circle cx="126" cy="100" r="9" fill="#2a1e32"/>
  <circle cx="71" cy="96" r="3" fill="#fff"/><circle cx="123" cy="96" r="3" fill="#fff"/>
  <ellipse cx="55" cy="122" rx="12" ry="6" fill="#ff8fa8" opacity="0.6"/><ellipse cx="145" cy="122" rx="12" ry="6" fill="#ff8fa8" opacity="0.6"/>
  {mouth}
</svg>"""

def sc_hello(img, d, t):
    stars(d, t, 40)
    x = 540 + math.sin(t * 1.6) * 260
    y = 900 + abs(math.sin(t * 3.2)) * -80
    talk = talk_amount(t)
    im = svg_img(svg_cat('talk' if talk > 0.3 else 'happy'), 420)
    put(img, im, x, y, 1.0 + 0.04 * math.sin(t * 6), 1.0, math.sin(t * 1.6) * 8)
    ptext(img, 'Motion Studio', 540, 330, 110, t, 0.1, fill=(255, 225, 60))
    ptext(img, 'ทดสอบระบบ', 540, 460, 80, t, wt('hello', 'ทดสอบ'))

def sc_bye(img, d, t):
    rays(d, 540, 900, t, (255, 255, 255, 30))
    s = pop(t, SEG['bye']['s'])
    put(img, svg_img(svg_cat('happy'), 420), 540, 950, s)
    confetti(d, t, SEG['bye']['s'], 540, 900)
    ptext(img, 'พร้อมแล้ว!', 540, 400, 120, t, wt('bye', 'พร้อม'), fill=(120, 255, 170))

SCENES = {'hello': (sc_hello, ((30, 20, 80), (90, 50, 150))), 'bye': (sc_bye, ((110, 50, 200), (230, 90, 170)))}
'''

PACKAGE = {
    'topic': 'Motion Studio acceptance test',
    'title_th': 'ทดสอบระบบ Motion Studio',
    'script': [
        {'id': 'hello', 'text': 'สวัสดีครับ นี่คือการทดสอบระบบ Motion Studio ภาพทุกเฟรมวาดด้วยโค้ด'},
        {'id': 'bye', 'text': 'เสียงพากย์ เอฟเฟกต์ และเพลง มาจาก ElevenLabs ตรงจากเซิร์ฟเวอร์ พร้อมแล้ว!'},
    ],
    'voice': {'voice_id': 'bcdIY58WBBzAMmef52NW', 'model_id': 'eleven_v4', 'language_code': 'th', 'stability': 0.4, 'similarity_boost': 0.75},
    'music': {'prompt': 'Short bright playful ukulele and marimba jingle, quiz show feel, instrumental', 'model_id': 'music_v1', 'volume': 0.3},
    'sfx': [{'id': 'pop', 'prompt': 'Cute bubbly cartoon pop', 'duration': 1.0,
             'cues': [{'seg': 'bye', 'word': 'พร้อม', 'n': 0, 'offset': 0.0, 'gain': 0.7}, {'seg': 'hello', 'at': 'start', 'offset': 0.1, 'gain': 0.6}]}],
    'scene_code': SCENE_CODE,
    'storyboard': [{'seg': 'hello', 'visual': 'SVG jelly cat bouncing across a starry sky', 'transition': 'iris'},
                   {'seg': 'bye', 'visual': 'cat pops in with confetti', 'sfx': 'pop'}],
    'sources': [], 'claims': [],
    'captions': {'default': 'Motion Studio test'},
}

TTS_TEXT = 'สวัสดีครับ นี่คือการทดสอบเสียงพากย์ภาษาไทย สร้างตรงจากเซิร์ฟเวอร์ของ Motion Studio'
