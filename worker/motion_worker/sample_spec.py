"""A sample generated episode that exercises every scene template (used by tests and the local preview tool)."""

SCRIPT = [
    {'id': 'hook', 'text': 'ถ้าคนไทยทุกคน เลิกเล่นมือถือ หนึ่งวัน จะเกิดอะไรขึ้น?'},
    {'id': 'hours', 'text': 'คนไทยใช้เน็ต เฉลี่ยวันละเกือบเก้าชั่วโมง มากกว่าเวลานอนอีก'},
    {'id': 'compare', 'text': 'เทียบกับค่าเฉลี่ยทั้งโลก ที่ประมาณหกชั่วโมงครึ่ง ไทยใช้นานกว่าเห็นๆ'},
    {'id': 'apps', 'text': 'แอปที่ใช้เยอะสุด คือ ไลน์ เฟซบุ๊ก ยูทูบ และติ๊กต็อก'},
    {'id': 'list', 'text': 'ถ้าวางมือถือหนึ่งวัน เราจะได้นอนมากขึ้น ได้คุยกับคนข้างๆ และได้เดินออกไปเจอแดด'},
    {'id': 'quiz', 'text': 'ทายก่อน! คนไทยกี่เปอร์เซ็นต์ ใช้อินเทอร์เน็ต? เอ ห้าสิบ บี เจ็ดสิบห้า ซี เก้าสิบ สาม สอง หนึ่ง!'},
    {'id': 'reveal', 'text': 'เฉลย ซี! เกือบเก้าสิบเปอร์เซ็นต์ เรียกว่าแทบทุกคน'},
    {'id': 'dots', 'text': 'ถ้ามีคนไทยร้อยคน จะมีเกือบเก้าสิบคน ที่ออนไลน์อยู่ตอนนี้'},
    {'id': 'myth', 'text': 'ที่เชื่อกันว่า แสงจากจอทำให้ตาบอด ไม่จริงนะ แต่ใช้นานไปทำให้ตาล้าได้'},
    {'id': 'history', 'text': 'ย้อนไปปีสองห้าห้าสาม สมาร์ทโฟนเพิ่งเริ่มฮิต ปีสองห้าหกสามโควิดทำให้ทุกอย่างออนไลน์'},
    {'id': 'icons', 'text': 'วันไม่มีมือถือ อาจได้อ่านหนังสือ ทำอาหาร ออกกำลังกาย หรือนอนหลับเต็มอิ่ม'},
    {'id': 'what', 'text': 'แต่ถ้าตั้มต้องวางมือถือจริงๆ เขาคงอยู่ได้ไม่ถึงเที่ยง'},
    {'id': 'close', 'text': 'แล้วคุณล่ะ วางมือถือได้นานแค่ไหน? คอมเมนต์บอกกันหน่อย'},
]

SCENES = [
    {'seg': 'hook', 'type': 'hook', 'bg': 'night', 'lines': [{'text': 'ถ้าคนไทยทุกคน', 'at': 'ถ้า'}, {'text': 'เลิกเล่นมือถือ 1 วัน?', 'at': 'เลิก'}],
     'icon': 'phone', 'icon_at': 'มือถือ', 'cat': {'mood': 'normal', 'react': {'mood': 'shock', 'at': 'จะเกิด'}}},
    {'seg': 'hours', 'type': 'number', 'bg': 'grape', 'headline': {'text': 'คนไทยใช้เน็ตวันละ', 'at': 'คนไทย'}, 'value': 8.9, 'decimals': 1,
     'suffix': ' ชม.', 'at': 'เกือบ', 'label': {'text': 'มากกว่าเวลานอนอีก!', 'at': 'มากกว่า'}, 'icon': 'clock',
     'note': {'text': 'ตัวเลขทดสอบระบบ (ไม่ใช่สถิติจริง)'}, 'cat': {'mood': 'shock'}},
    {'seg': 'compare', 'type': 'compare', 'bg': 'ocean', 'headline': {'text': 'ไทย vs ค่าเฉลี่ยโลก', 'at': 'เทียบ'},
     'items': [{'label': 'ทั้งโลก', 'value': 6.5, 'display': '6.5 ชม.', 'icon': 'globe', 'at': 'ทั้งโลก'},
               {'label': 'ไทย', 'value': 8.9, 'display': '8.9 ชม.', 'icon': 'thai_flag', 'at': 'ไทยใช้'}], 'highlight': 1, 'highlight_at': 'เห็นๆ'},
    {'seg': 'apps', 'type': 'bars', 'bg': 'teal', 'headline': {'text': 'แอปยอดฮิต', 'at': 'แอป'},
     'items': [{'label': 'LINE', 'value': 92, 'display': '92%', 'at': 'ไลน์'}, {'label': 'Facebook', 'value': 88, 'display': '88%', 'at': 'เฟซบุ๊ก'},
               {'label': 'YouTube', 'value': 85, 'display': '85%', 'at': 'ยูทูบ'}, {'label': 'TikTok', 'value': 70, 'display': '70%', 'at': 'ติ๊กต็อก'}]},
    {'seg': 'list', 'type': 'list', 'bg': 'mint', 'headline': {'text': 'วางมือถือ 1 วัน ได้อะไร?', 'at': 'ถ้า'}, 'mark': 'check',
     'items': [{'text': 'ได้นอนมากขึ้น', 'icon': 'sleep', 'at': 'นอน'}, {'text': 'ได้คุยกับคนข้างๆ', 'icon': 'people', 'at': 'คุย'},
               {'text': 'ได้ออกไปเจอแดด', 'icon': 'sun', 'at': 'เดิน'}], 'cat': {'mood': 'happy'}},
    {'seg': 'quiz', 'type': 'quiz', 'bg': 'berry', 'question': {'text': 'คนไทยกี่ % ใช้อินเทอร์เน็ต?', 'at': 'คนไทย'},
     'options': [{'letter': 'A', 'text': '50%', 'at': 'เอ'}, {'letter': 'B', 'text': '75%', 'at': 'บี'}, {'letter': 'C', 'text': '90%', 'at': 'ซี'}],
     'countdown': ['สาม', 'สอง', 'หนึ่ง'], 'cat': {'mood': 'worried'}, 'person': {'mood': 'think'}},
    {'seg': 'reveal', 'type': 'reveal', 'bg': 'sunset', 'options': [{'letter': 'A', 'text': '50%'}, {'letter': 'B', 'text': '75%'}, {'letter': 'C', 'text': '90%'}],
     'correct': 2, 'at': 'เฉลย', 'big': {'text': 'เกือบ 90%!', 'at': 'เกือบ'}, 'cat': {'mood': 'happy'}},
    {'seg': 'dots', 'type': 'dots', 'bg': 'sky', 'headline': {'text': 'คนไทย 100 คน', 'at': 'ถ้า'}, 'total': 100, 'highlight': 88, 'at': 'ร้อย',
     'highlight_at': 'เกือบ', 'label': {'text': '88 คนออนไลน์', 'at': 'ออนไลน์'}},
    {'seg': 'myth', 'type': 'truth', 'bg': 'ink', 'statement': {'text': 'แสงจากจอทำให้ตาบอด', 'at': 'แสง'}, 'verdict': False, 'verdict_at': 'ไม่จริง',
     'explain': {'text': 'แต่ใช้นานไป ทำให้ตาล้าได้', 'at': 'แต่'}, 'cat': {'mood': 'worried'}},
    {'seg': 'history', 'type': 'timeline', 'bg': 'gold', 'headline': {'text': 'ย้อนเวลาไปดู', 'at': 'ย้อน'},
     'items': [{'year': '2553', 'text': 'สมาร์ทโฟนเริ่มฮิต', 'at': 'สมาร์ทโฟน'}, {'year': '2563', 'text': 'โควิด: ทุกอย่างออนไลน์', 'at': 'โควิด'}]},
    {'seg': 'icons', 'type': 'icons', 'bg': 'peach', 'headline': {'text': 'วันไม่มีมือถือ', 'at': 'วัน'},
     'items': [{'icon': 'book', 'label': 'อ่านหนังสือ', 'at': 'อ่าน'}, {'icon': 'food', 'label': 'ทำอาหาร', 'at': 'ทำอาหาร'},
               {'icon': 'fitness', 'label': 'ออกกำลังกาย', 'at': 'ออกกำลัง'}, {'icon': 'sleep', 'label': 'นอนเต็มอิ่ม', 'at': 'นอน'}]},
    {'seg': 'what', 'type': 'scenario', 'bg': 'forest', 'bubble': {'text': 'ขอเช็กแป๊บเดียว...', 'at': 'แต่'}, 'icon': 'phone', 'icon_at': 'มือถือ',
     'person': {'mood': 'normal', 'react': {'mood': 'shock', 'at': 'ไม่ถึง'}}, 'cat': {'mood': 'happy'},
     'stamp': {'text': 'ไม่ถึงเที่ยง!', 'at': 'ไม่ถึง', 'color': 'red'}},
    {'seg': 'close', 'type': 'outro', 'bg': 'grape', 'lines': [{'text': 'คุณวางมือถือได้นานแค่ไหน?', 'at': 'แล้ว'}, {'text': 'คอมเมนต์บอกกันหน่อย!', 'at': 'คอมเมนต์'}],
     'icon_at': 'คอมเมนต์', 'cat': {'mood': 'happy'}},
]


def spec():
    return {'scenes': SCENES, 'text': {s['id']: s['text'] for s in SCRIPT}}
