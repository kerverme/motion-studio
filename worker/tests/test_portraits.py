"""Bespoke reference art renders through the same path in scenes and covers."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from engine import artkit, characters, core, templates

PORTRAIT = '''def draw(c, t, p):
    c.rect(-70, 100, 140, 270, '#1260ad')
    c.ellipse(0, 0, 100, 130, '#e9b98f')
    c.path([(-85,-50),(-40,-80),(10,-75),(75,-35)], '#34211a', w=22)
    c.ellipse(-35,-20,20,8,'black')
    c.ellipse(35,-20,20,8,'black')
    c.line(0,-10,-8,30,'brown',w=5)
    c.arc(0,42,25,0,180,'brown',w=4)
    if c.mood == 'happy':
        c.circle(0,50,10,'red')
'''

class PortraitTests(unittest.TestCase):
    def test_custom_face_and_body_used_by_normal_draw_person(self):
        image = Image.new('RGBA', (500, 700))
        style = characters.look_style({'portrait_code': PORTRAIT})
        characters.draw_person(image, 250, 180, 200, 0, style=style, mood='happy')
        self.assertEqual(image.getpixel((250, 500))[:3], (18, 96, 173))
        self.assertEqual(image.getpixel((250, 230))[:3], (230, 70, 70))
        self.assertEqual(image.getpixel((0, 0))[3], 0)
        self.assertGreater(image.getbbox()[3], 500)

    def test_legacy_cast_still_draws(self):
        image = Image.new('RGBA', (500, 700))
        characters.draw_person(image, 250, 180, 150, 0, style=characters.look_style({'top_color':'red'}))
        self.assertIsNotNone(image.getbbox())

    def test_bad_portrait_is_not_silently_replaced_by_generic_face(self):
        image = Image.new('RGBA', (500, 700))
        with self.assertRaises(artkit.ArtError):
            characters.draw_person(image, 250, 180, 150, 0, style={'portrait_code':'def draw(c,t,p):\n    c.person("self",0,0)'})
        self.assertIsNone(image.getbbox())

    def test_portrait_no_background_or_recursion_hooks(self):
        for method in ('person', 'cat', 'grad'):
            with self.subTest(method=method), self.assertRaises(artkit.ArtError):
                artkit.compile_portrait(f'def draw(c,t,p):\n    x = c.{method}')
        with self.assertRaises(artkit.ArtError):
            artkit.compile_portrait('import os\ndef draw(c,t,p):\n    pass')

    def test_compilation_cannot_execute_generated_calls_or_loops(self):
        for source in ('def f():\n    return f()\nx=f()\ndef draw(c,t,p):\n    pass',
                       'def f(x=range(300)):\n    pass\ndef draw(c,t,p):\n    pass',
                       'for i in range(300):\n    x=1\ndef draw(c,t,p):\n    pass'):
            with self.subTest(source=source), self.assertRaises(artkit.ArtError):
                artkit.compile_portrait(source)

    def test_nested_portraits_share_scene_shape_budget(self):
        image = Image.new('RGBA', (500, 700))
        portrait = 'def draw(c,t,p):\n    c.circle(0,0,10,"red")'
        scene = artkit.compile_art('', 'def draw(c,t,p):\n    for i in range(12):\n        c.person("x",100,100)')
        def person(im, who, x, y, size, mood, talk, pose, wave):
            artkit.draw_portrait(im, portrait, x, y, size, 0)
        with patch.object(artkit, 'MAX_SHAPES', 10), self.assertRaisesRegex(artkit.ArtError, 'too many shapes'):
            artkit.run(scene, image, 0, 0, {'person':person})

    def test_scene_preflight_reports_bad_portrait_and_unknown_cast(self):
        core.load_timeline([{'id':'s1','s':0,'e':2,'phrases':[]}])
        for cast, code, expected in [
            ([{'name':'x','portrait_code':'bad code'}], 'def draw(c,t,p):\n    c.person("x",540,600)', 'portrait x'),
            ([{'name':'x','portrait_code':PORTRAIT}], 'def draw(c,t,p):\n    c.person("missing",540,600)', 'unknown cast')]:
            templates.ERRORS.clear()
            with self.assertRaisesRegex(artkit.ArtError, expected):
                templates.build_scenes({'cast':cast,'scenes':[{'seg':'s1','type':'custom','code':code}]})

    def test_custom_scene_uses_reference_portrait_without_errors(self):
        core.load_timeline([{'id':'s1','s':0,'e':2,'phrases':[]}])
        templates.ERRORS.clear()
        spec = {'cast':[{'name':'x','portrait_code':PORTRAIT}], 'scenes':[{'seg':'s1','type':'custom','code':'def draw(c,t,p):\n    c.grad("sky","cream")\n    c.person("x",540,600,200,"happy")'}]}
        scenes = templates.build_scenes(spec)
        image = Image.new('RGBA', (1080,1920))
        from PIL import ImageDraw
        scenes['s1'][0](image, ImageDraw.Draw(image), .5)
        self.assertEqual(image.getpixel((540, 920))[:3], (18,96,173))
        self.assertEqual(templates.ERRORS, [])

    def test_late_frame_error_fails_new_scene_instead_of_generic_fallback(self):
        core.load_timeline([{'id':'s1','s':0,'e':10,'phrases':[]}])
        spec = {'cast':[{'name':'x','portrait_code':PORTRAIT}], 'scenes':[{'seg':'s1','type':'custom','code':'def draw(c,t,p):\n    c.grad("sky","cream")\n    if t > 9.5:\n        x = 1/0\n    c.person("x",540,600)'}]}
        scenes = templates.build_scenes(spec)
        image = Image.new('RGBA', (1080,1920))
        from PIL import ImageDraw
        scenes['s1'][0](image, ImageDraw.Draw(image), 1)
        with self.assertRaisesRegex(artkit.ArtError, 'ZeroDivisionError'):
            scenes['s1'][0](image, ImageDraw.Draw(image), 9.8)

    def test_cover_draws_same_custom_portrait(self):
        import tempfile
        from types import SimpleNamespace
        from motion_worker.pipeline import make_cover
        ctx = SimpleNamespace(pkg={'cover':{'name':'x','who':'x','line':'a story'}, 'spec':{'cast':[{'name':'x','portrait_code':PORTRAIT}]},'style':'classic'})
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp)/'cover.png')
            make_cover(ctx, 1, path)
            image = Image.open(path)
            self.assertEqual(image.getpixel((540,1450))[:3], (18,96,173))

    def test_cover_portrait_error_propagates_instead_of_thumbnail_fallback(self):
        from types import SimpleNamespace
        from motion_worker.pipeline import make_thumbnail
        ctx = SimpleNamespace(pkg={'cover':{'name':'x','who':'x'},'spec':{'cast':[{'name':'x','portrait_code':'bad'}]}})
        with self.assertRaises(artkit.ArtError):
            make_thumbnail(ctx, {}, 1, '/tmp/invalid-portrait-cover.png')

if __name__ == '__main__':
    unittest.main()
