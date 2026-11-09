"""Comic post-processing must retain detail in already inked artwork."""
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import artkit, core, styles


class ComicStyleTests(unittest.TestCase):
    def small_face(self):
        image = Image.new('RGBA', (core.W, core.H), '#98beac')
        c = artkit.Canvas(image)
        # A small side character, with narrow white gaps around the pupils.
        c.ellipse(540, 760, 40, 47, '#d8b999', outline='#191c2b', ow=3)
        for x in (524, 556):
            c.ellipse(x, 750, 9, 10, '#fff5d6', outline='#191c2b', ow=2)
            c.circle(x + 2, 750, 4, '#191c2b')
        c.path([(525, 781), (540, 789), (555, 781)], '#191c2b', w=3, smooth=True)
        return image

    def test_small_face_keeps_eye_whites_and_skin_between_ink_lines(self):
        source = self.small_face()
        result = styles.apply('comic', source)
        before = np.asarray(source.convert('L'))[710:810, 495:585]
        after = np.asarray(result.convert('L'))[710:810, 495:585]
        # Newly black pixels are precisely what hid the eyes and face in EP012.
        light_detail = before > 100
        self.assertGreater(int(light_detail.sum()), 1000)
        self.assertTrue(np.all(after[light_detail] > 70))
        white_detail = before > 220
        self.assertGreater(int(white_detail.sum()), 50)
        self.assertTrue(np.all(after[white_detail] > 200))

    def test_text_counters_and_thin_gaps_do_not_fill_with_ink(self):
        source = Image.new('RGBA', (core.W, core.H), '#fff5d6')
        c = artkit.Canvas(source)
        c.text(540, 750, 'เบล 808', 35, '#191c2b', stroke=0)
        # Also cover narrow negative spaces independent of font rasterization.
        for x in (480, 500, 520):
            c.rect(x, 800, 3, 30, '#191c2b')
            c.rect(x + 6, 800, 3, 30, '#191c2b')
        before = np.asarray(source.convert('L'))[700:840, 430:650]
        after = np.asarray(styles.apply('comic', source).convert('L'))[700:840, 430:650]
        self.assertGreater(int((before < 60).sum()), 100)
        self.assertTrue(np.all(after[before > 220] > 200))

    def test_character_layer_gets_the_same_detail_preservation(self):
        source = self.small_face()
        # Compare the apply path used for separate character layers to world art.
        chars = Image.new('RGBA', source.size)
        chars.paste(source.crop((490, 705, 590, 815)), (490, 705))
        world = Image.new('RGBA', source.size, '#98beac')
        layered = styles.apply('comic', world, chars)
        direct = styles.apply('comic', source)
        self.assertTrue(np.array_equal(np.asarray(layered), np.asarray(direct)))

    def test_comic_still_adds_a_subtle_print_texture(self):
        source = Image.new('RGB', (core.W, core.H), (130, 145, 155))
        result = np.asarray(styles.comic(source, 0))[100:300, 100:300]
        self.assertGreater(len(np.unique(result.reshape(-1, 3), axis=0)), 1)
        # The style should not turn an ordinary midtone into near-black ink.
        self.assertGreater(int(result.min()), 90)


if __name__ == '__main__':
    unittest.main()
