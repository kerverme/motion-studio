"""Builds the EP002 episode package (what Claude submits to POST /jobs)."""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
scene_code = open(os.path.join(ROOT, 'episodes/ep002-tum/scenes.py'), encoding='utf-8').read()

script = [
    {'id': 'hook', 'text': 'คนชื่อตั้ม ในประเทศไทย มีกี่คน? แล้วกี่เปอร์เซ็นต์ ที่ต้องใส่แว่น?'},
    {'id': 'pop', 'text': 'คนไทยตอนนี้ มีราวหกสิบห้าล้านคน ตามทะเบียนราษฎร์ สิ้นปีสองห้าหกเจ็ด'},
    {'id': 'nodata', 'text': 'แต่รู้ไหม? ชื่อเล่น ไม่ได้อยู่ในทะเบียนราษฎร์ เลยไม่มีใครนับตั้มได้จริงๆ แถมลิสต์ชื่อเล่นโหลที่แชร์กันในเน็ต ก็ไม่มีชื่อตั้ม ติดท็อปเท็นเลย'},
    {'id': 'estimate', 'text': 'งั้นลองสมมติเล่นๆ ถ้าคนไทยทุกหนึ่งพันคน มีตั้มหนึ่งคน ประเทศไทยจะมีตั้ม ราวหกหมื่นห้าพันคน'},
    {'id': 'guess', 'text': 'ทายก่อน! ผลสำรวจสายตาระดับประเทศ พบว่าคนไทยอายุยี่สิบเอ็ดถึงสี่สิบปี มีปัญหาค่าสายตากี่เปอร์เซ็นต์? เอ สิบ. บี ยี่สิบห้า. ซี สี่สิบเก้า. สาม... สอง... หนึ่ง!'},
    {'id': 'reveal', 'text': 'เฉลย ซี! สี่สิบเก้าเปอร์เซ็นต์ เกือบครึ่ง! แปลว่าตั้มวัยทำงาน เกือบครึ่ง อาจต้องพึ่งแว่น'},
    {'id': 'myth', 'text': 'แล้วที่เชื่อกันว่า ใส่แว่นแล้วสายตาจะแย่ลง ไม่จริงนะ! ค่าสายตาเปลี่ยนตามอายุ หรือภาวะสายตาที่เป็นอยู่ ไม่ใช่เพราะแว่น ส่วนการตัดแว่นให้อ่อนกว่าค่าจริง ก็ไม่ได้ช่วยชะลอสายตาสั้น'},
    {'id': 'world', 'text': 'นักวิจัยยังคาดว่า ปีสองพันห้าสิบ คนครึ่งโลกจะสายตาสั้น เพราะใช้สายตาระยะใกล้มากขึ้น และออกไปเจอแดดน้อยลง'},
    {'id': 'close', 'text': 'แล้วถ้าอยากให้เราค้นหาสถิติของใครเป็นคนต่อไป พิมพ์ชื่อเพื่อนของคุณไว้ใต้คอมเมนต์ได้เลยครับ'},
]

sources = [
    {'url': 'https://www.dailynews.co.th/news/5362885/', 'publisher': 'เดลินิวส์ (อ้างประกาศสำนักทะเบียนกลาง ในราชกิจจานุเบกษา 24 ม.ค. 2568)',
     'title': 'จำนวนราษฎรทั่วราชอาณาจักร ณ 31 ธ.ค. 2567', 'published': '2025-01', 'collected': '2024-12-31',
     'methodology': 'Civil registration count (ทะเบียนราษฎร)', 'confidence': 'high',
     'limitations': 'Counts 64,953,661 Thai nationals by registration; registration ≠ residence; nicknames are not recorded.',
     'claim': 'คนไทยราว 65 ล้านคน'},
    {'url': 'https://www.sanook.com/campus/1426683/', 'publisher': 'Sanook Campus', 'title': '10 อันดับชื่อเล่นที่โหลที่สุดในไทย', 'published': '2024-09-18',
     'methodology': 'Not disclosed by the publisher', 'confidence': 'low',
     'limitations': 'Popular-media list with no stated method; used only to say the widely shared list does not include “ตั้ม”.',
     'claim': 'ลิสต์ชื่อเล่นโหลที่แชร์กันไม่มีชื่อตั้มในท็อป 10'},
    {'url': 'https://ph04.tci-thaijo.org/index.php/JCST/article/view/580', 'publisher': 'Journal of Current Science and Technology',
     'title': 'Refractive errors: the major visual impairment in Thailand', 'published': '2012', 'collected': '2006 (4th national survey)',
     'methodology': 'National eye survey, 21,711 people, 42 districts in 21 provinces + Bangkok', 'confidence': 'medium',
     'limitations': '49% is the reported refractive-error prevalence for ages 21–40 in 2006 data; it measures refractive error, not spectacle wearing.',
     'claim': 'คนไทยอายุ 21–40 ปี มีปัญหาค่าสายตา 49%'},
    {'url': 'https://www.eyenews.uk.com/reviews/my-top-five/post/my-top-five-debunking-common-myths-in-ophthalmology-and-vision-care',
     'publisher': 'Eye News', 'title': 'My top five: debunking common myths in ophthalmology and vision care', 'confidence': 'medium',
     'methodology': 'Clinical review citing trials (Walline et al.; Ong et al.)',
     'limitations': 'Review article; cites children’s myopia trials.', 'claim': 'ใส่แว่นไม่ได้ทำให้สายตาแย่ลง; ตัดแว่นอ่อนไม่ชะลอสายตาสั้น'},
    {'url': 'https://www.sciencedaily.com/releases/2016/02/160217113308.htm', 'publisher': 'ScienceDaily (Holden et al., Ophthalmology 2016)',
     'title': 'Half the world to be short-sighted by 2050', 'published': '2016-02-17', 'methodology': 'Meta-analysis of 145 studies, projection to 2050',
     'confidence': 'medium', 'limitations': 'Projection, depends on current trends continuing.', 'claim': 'ปี 2050 คนครึ่งโลกจะสายตาสั้น'},
]

claims = [
    {'text': 'คนไทยราว 65 ล้านคน ตามทะเบียนราษฎร์ สิ้นปี 2567', 'source_ids': [0], 'kind': 'fact'},
    {'text': 'ชื่อเล่นไม่อยู่ในทะเบียนราษฎร์ จึงไม่มีตัวเลขทางการของคนชื่อตั้ม', 'source_ids': [0], 'kind': 'fact'},
    {'text': 'ลิสต์ชื่อเล่นโหลท็อป 10 ที่แชร์กันไม่มีชื่อตั้ม', 'source_ids': [1], 'kind': 'fact'},
    {'text': 'ราว 65,000 ตั้ม (สมมติ 1 ใน 1,000 คน) — แสดงเป็นการสมมติ ไม่ใช่สถิติ', 'source_ids': [], 'kind': 'assumption'},
    {'text': 'คนไทยอายุ 21–40 ปี มีปัญหาค่าสายตา 49% (ผลสำรวจระดับชาติ ปี 2549)', 'source_ids': [2], 'kind': 'fact'},
    {'text': 'ใส่แว่นไม่ได้ทำให้สายตาแย่ลง และการตัดแว่นอ่อนกว่าค่าจริงไม่ชะลอสายตาสั้น', 'source_ids': [3], 'kind': 'fact'},
    {'text': 'นักวิจัยคาดว่าปี 2050 คนครึ่งโลกจะสายตาสั้น', 'source_ids': [4], 'kind': 'fact'},
]

def cue(seg, word=None, n=0, offset=0.0, gain=0.8, at=None):
    c = {'seg': seg, 'n': n, 'offset': offset, 'gain': gain}
    if word: c['word'] = word
    if at: c['at'] = at
    return c

sfx = [
    {'id': 'glint', 'prompt': 'Cartoon magical sparkle with a bright high glint "ting" on eyeglasses, short and playful', 'duration': 1.5,
     'cues': [cue('hook', 'แว่น', offset=-0.1, gain=0.6), cue('myth', 'ไม่', n=1, offset=0.2, gain=0.55)]},
    {'id': 'counter', 'prompt': 'Fast mechanical number counter rolling up with rapid clicks, ending in a soft bell', 'duration': 2.5,
     'cues': [cue('pop', 'มี', gain=0.45)]},
    {'id': 'buzzer', 'prompt': 'Short comedic cartoon wrong-answer buzzer, two quick low beeps', 'duration': 1.0,
     'cues': [cue('nodata', 'ไม่', offset=0.15, gain=0.55), cue('myth', 'ก็', offset=0.2, gain=0.5)]},
    {'id': 'listflip', 'prompt': 'Quick paper pages flipping through a list, ending with a soft cartoon boop', 'duration': 2.0,
     'cues': [cue('nodata', 'แถม', gain=0.45)]},
    {'id': 'stamp', 'prompt': 'Cartoon rubber stamp thump on paper with a tiny springy bounce', 'duration': 1.0,
     'cues': [cue('nodata', 'มีชื่อ', gain=0.6), cue('estimate', at='start', offset=0.1, gain=0.6)]},
    {'id': 'drumroll', 'prompt': 'Game show snare drumroll building tension with a ticking clock, rising to a cymbal hit at the end', 'duration': 6.0,
     'cues': [cue('reveal', at='start', offset=-6.0, gain=0.35)]},
    {'id': 'correct', 'prompt': 'Game show correct-answer ding chime followed by a small crowd cheer and applause', 'duration': 3.0,
     'cues': [cue('reveal', at='start', gain=0.6)]},
    {'id': 'scratch', 'prompt': 'Vinyl record scratch stop followed by a comedic sad trombone wah-wah', 'duration': 2.0,
     'cues': [cue('myth', 'ไม่', gain=0.55)]},
    {'id': 'globe', 'prompt': 'Big airy cinematic whoosh of a globe spinning past, with a soft shimmer tail', 'duration': 2.0,
     'cues': [cue('world', at='start', gain=0.5)]},
    {'id': 'comment', 'prompt': 'Cute bubbly cartoon pop followed by a cheerful phone notification ping', 'duration': 1.5,
     'cues': [cue('close', 'คอมเมนต์', gain=0.7)]},
]

storyboard = [
    {'seg': 'hook', 'visual': 'Tum (code-drawn from reference photo) sits on a bench by a red-brick wall with teal window, ivy and lantern; jelly cat beside him', 'animation': 'glasses glint on “แว่น”, shocked face, title pops', 'onscreen': 'คนชื่อตั้มในไทย มีกี่คน? / กี่ % ใส่แว่น?', 'sfx': 'glint', 'transition': 'iris'},
    {'seg': 'pop', 'visual': 'crowd fills the frame while a counter rolls to 64,953,661', 'animation': 'counter roll + crowd grow', 'onscreen': 'ราว 65 ล้านคน + source line', 'sfx': 'counter', 'transition': 'iris'},
    {'seg': 'nodata', 'visual': 'registry form with ✓ for name/surname/birthday and ✗ for nickname; then the popular top-10 list scanned by a magnifier', 'animation': 'stamps “ไม่มีช่องนี้!” and “ไม่มี ตั้ม!”', 'onscreen': 'ไม่มีช่องนี้! / ไม่มี “ตั้ม”!', 'sfx': 'buzzer, listflip, stamp', 'transition': 'iris'},
    {'seg': 'estimate', 'visual': '1,000 dots with one Tum highlighted, then 65,000,000 ÷ 1,000 and a shower of Tum icons', 'animation': '“สมมติ!” stamp makes the assumption explicit', 'onscreen': 'สมมติ! / ราว 65,000 ตั้ม', 'sfx': 'stamp', 'transition': 'iris'},
    {'seg': 'guess', 'visual': 'quiz rays, survey card, options A 10% / B 25% / C 49%, 3-2-1 countdown', 'animation': 'options pop on each letter, countdown ring', 'onscreen': 'ทายก่อน! คอมเมนต์ A B หรือ C', 'sfx': 'drumroll', 'transition': 'iris'},
    {'seg': 'reveal', 'visual': 'C highlighted, donut fills to 49%, then 10 Tums of which ~5 put on glasses', 'animation': 'confetti, donut fill', 'onscreen': 'เฉลย C! 49% เกือบครึ่ง!', 'sfx': 'correct', 'transition': 'iris'},
    {'seg': 'myth', 'visual': 'myth card “ใส่แว่นแล้วสายตาแย่ลง?” stamped ไม่จริง!, two reasons with ticks; second myth with a big ✗', 'animation': 'stamp, checklist reveal', 'onscreen': 'ความเชื่อผิด! / ไม่ใช่เพราะแว่น / ไม่ได้ช่วย', 'sfx': 'scratch, glint, buzzer', 'transition': 'iris'},
    {'seg': 'world', 'visual': 'spinning globe half-shaded, phone (near work) and sun (less outdoor time)', 'animation': 'globe shade sweep', 'onscreen': 'ปี ค.ศ. 2050 ครึ่งโลกสายตาสั้น', 'sfx': 'globe', 'transition': 'iris'},
    {'seg': 'close', 'visual': 'back to the brick wall; Tum waves, friend-name bubbles orbit, comment icon', 'animation': 'wave, orbiting names', 'onscreen': 'พิมพ์ชื่อเพื่อนใต้คอมเมนต์ได้เลย!', 'sfx': 'comment', 'transition': 'iris'},
]

tags = '#จะเกิดอะไรขึ้นถ้า #ชื่อเล่น #ตั้ม #สายตาสั้น #ใส่แว่น #รู้หรือไม่ #สถิติ #แมววุ้น'
base = ('คนชื่อ “ตั้ม” ในไทยมีกี่คน? แล้วกี่ % ต้องใส่แว่น? 🤓\n'
        'ทายก่อนดูเฉลย: คนไทยวัย 21–40 ปี มีปัญหาค่าสายตากี่ %? A 10% B 25% C 49%\n'
        'ชื่อเล่นไม่อยู่ในทะเบียนราษฎร์ ตัวเลขตั้มในคลิปจึงเป็นการสมมติ ไม่ใช่สถิติจริง\n'
        'อยากให้ค้นสถิติชื่อใครต่อ พิมพ์ชื่อเพื่อนใต้คอมเมนต์ได้เลย!\n'
        'อ้างอิง: สำนักทะเบียนกลาง (31 ธ.ค. 2567), ผลสำรวจสายตาระดับชาติ 2549, Holden et al. 2016')
captions = {
    'facebook': base + '\n\n' + tags,
    'instagram': base + '\n.\n.\n' + tags + ' #reels',
    'tiktok': 'คนชื่อตั้มในไทยมีกี่คน กี่ % ใส่แว่น? ทายก่อน A B C 👇 แท็กชื่อเพื่อนคนต่อไป! ' + tags + ' #tiktokuni',
    'youtube': 'คนชื่อตั้มในไทยมีกี่คน? กี่ % ใส่แว่น? #shorts\n' + base + '\n' + tags,
}

pkg = {
    'topic': 'คนชื่อตั้มในประเทศไทยมีกี่คน และมีกี่เปอร์เซ็นต์ที่ใส่แว่น?',
    'title_th': 'คนชื่อตั้มในไทยมีกี่คน กี่เปอร์เซ็นต์ใส่แว่น',
    'series_tag': 'จะเกิดอะไรขึ้นถ้า...?',
    'script': script,
    'voice': {'voice_id': 'bcdIY58WBBzAMmef52NW', 'model_id': 'eleven_v4', 'language_code': 'th', 'stability': 0.4, 'similarity_boost': 0.75},
    'music': {'prompt': 'Playful, curious background music for a short fun-fact video: bouncy pizzicato strings, ukulele and light marimba, soft claps, about 100 BPM, bright and friendly like a quirky quiz show, steady groove under narration, instrumental', 'model_id': 'music_v1', 'volume': 0.3},
    'sfx': sfx,
    'scene_code': scene_code,
    'storyboard': storyboard,
    'sources': sources,
    'claims': claims,
    'captions': captions,
    'thumbnail': {'seg': 'hook', 'offset': 1.2, 'title': 'ทายก่อน! A · B · C ?'},
    'budget': {'max_credits': 4500},
}
out = os.path.join(ROOT, 'episodes/ep002-tum/package.json')
json.dump(pkg, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(out, len(json.dumps(pkg, ensure_ascii=False)))
