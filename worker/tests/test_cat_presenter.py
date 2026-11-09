"""A named custom cat presenter uses the same strict cast path as other artwork."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw
from engine import artkit, characters, core, templates

CAT_PORTRAIT = '''def draw(c,t,p):
    c.path([(70,240),(140,210),(145,150)],"orange",w=22)
    c.rect(-65,90,130,190,"#1260ad")
    c.ellipse(-35,295,32,25,"orange")
    c.ellipse(35,295,32,25,"orange")
    c.poly([(-90,-65),(-72,-150),(-20,-68)],"orange")
    c.poly([(20,-68),(72,-150),(90,-65)],"orange")
    c.ellipse(0,-10,100,85,"orange")
    c.ellipse(0,25,55,34,"cream")
    c.ellipse(-36,-22,17,22,"green")
    c.ellipse(36,-22,17,22,"green")
    c.ellipse(-36,-22,5,17,"black")
    c.ellipse(36,-22,5,17,"black")
    c.poly([(-9,10),(9,10),(0,21)],"pink")
    c.line(-45,20,-100,6,"black",w=3)
    c.line(45,20,100,6,"black",w=3)
    c.line(-45,30,-105,36,"black",w=3)
    c.line(45,30,105,36,"black",w=3)
    if c.talk > 0.5:
        c.ellipse(0,40,14,10,"black")
    else:
        c.line(-12,40,12,40,"black",w=4)
'''

class CatPresenterTests(unittest.TestCase):
    def test_custom_cat_is_rendered_instead_of_the_human_body(self):
        artkit.compile_portrait(CAT_PORTRAIT)
        image = Image.new('RGBA', (500,700))
        characters.draw_person(image,250,180,200,0,style=characters.look_style({'portrait_code':CAT_PORTRAIT}))
        self.assertEqual(image.getpixel((178,60))[:3],(250,150,50),'the cat ear must survive the named-actor path')
        self.assertEqual(image.getpixel((250,350))[:3],(18,96,173),'the saved cat outfit must be used')

    def test_named_cat_scene_reuses_identity_while_forwarding_speech_animation(self):
        core.load_timeline([{'id':'explain','s':0,'e':2,'phrases':[]}])
        templates.ERRORS.clear()
        spec={'strict_art':True,'cast':[{'name':'น้องส้ม','portrait_code':CAT_PORTRAIT}],
              'scenes':[{'seg':'explain','type':'custom','code':'def draw(c,t,p):\n    c.grad("sky","cream")\n    c.person("น้องส้ม",540,600,200,talk=clamp(t,0,1))'}]}
        scene=templates.build_scenes(spec)['explain'][0]
        frames=[]
        for t in (0,1):
            image=Image.new('RGBA',(1080,1920));scene(image,ImageDraw.Draw(image),t);frames.append(image)
            self.assertEqual(image.getpixel((468,480))[:3],(250,150,50))
            self.assertEqual(image.getpixel((540,770))[:3],(18,96,173))
        self.assertNotEqual(frames[0].tobytes(),frames[1].tobytes())
        self.assertEqual(templates.ERRORS,[])
