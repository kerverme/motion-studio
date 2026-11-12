"""The restored graphics use the real EP004 renderer, including its Thai typography."""
import sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import ImageChops, ImageStat, ImageDraw
from engine import core, templates, render, artkit
from motion_worker.artcheck import check
from motion_worker.preview import scene_code

CODE='def draw(c,t,p):\n  c.circle(540+50*p,1320,50,"teal")'

class ClassicPresentationTests(unittest.TestCase):
    def payload(self, graphic, code=CODE):
        return {'presentation_version':1,'strict_art':True,'opening_frame_cover':True,'cast':[],
                'script':[{'id':'demo','text':'ดูตัวอย่าง จำนวนสามส่วน ค่อยค่อยปรากฏขึ้น'}],
                'scenes':[{'seg':'demo','type':'custom','code':code,'bg':'sky',
                           'headline':{'text':'ดูจำนวนนี้'},'graphic':graphic}]}

    def test_number_cards_match_original_template_pixels_and_move_with_the_cue(self):
        graphic={'type':'number','value':300,'at':'จำนวน','label':{'text':'ส่วน','at':'ส่วน'}}
        timeline=[{'id':'demo','s':.2,'e':4,'phrases':[{'text':'ดูจำนวนสามส่วน','s':.2,'e':4,'words':[{'w':'จำนวน','s':.5,'e':1},{'w':'ส่วน','s':2,'e':3}]}]}]
        spec=self.payload(graphic);spec['text']={'demo':spec['script'][0]['text']}
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'scene.py';path.write_text(scene_code(spec))
            mod=render.load_episode_module(str(path),timeline,4,'','classic')
            pictures=[]
            for t in [.6,1.2,2.4]:
                actual=render.scene_frame(mod,'demo',t)
                expected=core.gradient(*templates.PALETTES['sky'])
                drawer=ImageDraw.Draw(expected,'RGBA')
                from PIL import Image
                drawer.draw=Image.core.draw(expected.im,1)  # same alpha blending as the frame compositor
                templates.T_number(expected,drawer,t,'demo',graphic)
                # Exact same font, counter, card, scale and position as the original template.
                crop=(20,500,1060,1170)
                self.assertIsNone(ImageChops.difference(actual.crop(crop).convert('RGB'),expected.crop(crop).convert('RGB')).getbbox())
                pictures.append(actual.crop(crop).tobytes())
            self.assertNotEqual(pictures[0],pictures[1]);self.assertNotEqual(pictures[1],pictures[2])

    def test_preview_includes_graphics_and_frame_zero_without_inserting_a_cat(self):
        payload=self.payload({'type':'hook','lines':[{'text':'ภาพเดิมกลับมาแล้ว'}]})
        with patch.object(templates,'mascots',side_effect=AssertionError('must not inject mascot')):
            result=check(payload)
        self.assertEqual(result['presentation_version'],1)
        self.assertEqual(result['scenes'][0]['errors'],[])
        self.assertEqual(len(result['scenes'][0]['frames']),3)
        import base64,io
        from PIL import Image
        opening=Image.open(io.BytesIO(base64.b64decode(result['scenes'][0]['frames'][0])))
        self.assertGreater(ImageStat.Stat(opening.crop((20,190,412,300)).convert('L')).stddev[0],15)

    def test_failed_illustration_or_unknown_graphic_never_becomes_generic_art(self):
        result=check(self.payload({'type':'illustration'},'def draw(c,t,p):\n  x=1/0'))
        self.assertTrue(result['scenes'][0]['errors']);self.assertEqual(result['scenes'][0]['frames'],[])
        with self.assertRaises(artkit.ArtError):check(self.payload({'type':'unsupported'}))

    def test_all_graphic_layouts_reach_real_preview_without_characters(self):
        line={'text':'ตัวอย่าง','at':'ตัวอย่าง'}
        graphics=[{'type':'illustration'}, {'type':'list','items':[line,line]},
                  {'type':'truth','statement':line,'verdict':False,'verdict_text':'ยังสรุปไม่ได้','verdict_at':'สาม'},
                  {'type':'compare','items':[{'label':'ก่อน','value':1,'at':'ตัวอย่าง'},{'label':'หลัง','value':3,'at':'สาม'}]},
                  {'type':'chat','title':'ตัวอย่าง','messages':[{**line,'from':'left'},{**line,'from':'right'}]},
                  {'type':'icons','items':[{'icon':'book','label':'ตัวอย่าง','at':'ตัวอย่าง'},{'icon':'brain','label':'คิด','at':'สาม'}]},
                  {'type':'outro','lines':[line], 'icon_at':'ตัวอย่าง'}]
        for graphic in graphics:
            with self.subTest(layout=graphic['type']):
                payload=self.payload(graphic);payload['opening_frame_cover']=False
                with patch.object(templates,'mascots',side_effect=AssertionError('must not inject mascot')):
                    result=check(payload)
                self.assertEqual(result['scenes'][0]['errors'],[])
                self.assertEqual(len(result['scenes'][0]['frames']),2)

if __name__=='__main__':unittest.main()
