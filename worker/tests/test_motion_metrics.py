"""Temporal review cannot use subtitle motion as evidence of scene animation."""
import base64
import io
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw
from motion_worker.motion_metrics import analyse_frames, sample_times, capture_motion
from motion_worker.artcheck import check
from motion_worker.preview import fake_timeline


def picture(x=100, subtitle=False):
    image=Image.new('RGB',(1080,1920),'white');draw=ImageDraw.Draw(image)
    draw.rectangle((x,600,x+180,850),fill='blue')
    if subtitle: draw.rectangle((x,1450,x+500,1600),fill='black')
    return image


class MotionMetricsTests(unittest.TestCase):
    def payload(self, code, **options):
        return {'strict_art':True,'motion_review':True,
                'script':[{'id':'one','text':'ภาพอธิบาย หนึ่ง สอง สาม สี่ ห้า หก เจ็ด แปด'}],
                'cast':[],'art':'','scenes':[{'seg':'one','type':'custom','code':code}],**options}

    def test_static_frames_report_one_held_interval_without_a_semantic_failure(self):
        result=analyse_frames([picture()]*4,[0,1,2,3])
        self.assertEqual(result['longest_hold_seconds'],3)
        self.assertEqual(result['held_intervals'],[{'start':0.0,'end':3.0,'seconds':3.0}])
        self.assertNotIn('pass',result)

    def test_real_object_movement_breaks_hold_and_adjacent_holds_merge(self):
        moving=analyse_frames([picture(x) for x in (100,300,500,700)],[0,1,2,3])
        self.assertEqual(moving['longest_hold_seconds'],0)
        self.assertGreater(moving['max_changed_fraction'],.01)
        result=analyse_frames([picture(100)]*3+[picture(500)]*2,[0,1,2,3,4])
        self.assertEqual(result['held_intervals'],[{'start':0.0,'end':2.0,'seconds':2.0},{'start':3.0,'end':4.0,'seconds':1.0}])

    def test_subtitle_and_header_regions_cannot_create_content_activity(self):
        frames=[]
        for i in range(4):
            image=picture();draw=ImageDraw.Draw(image)
            draw.rectangle((30+i*150,1450,180+i*150,1600),fill='black')
            draw.rectangle((30+i*150,50,180+i*150,150),fill='black');frames.append(image)
        result=analyse_frames(frames,[0,1,2,3])
        self.assertEqual(result['max_changed_fraction'],0)
        self.assertEqual(result['longest_hold_seconds'],3)

    def test_sampling_and_shared_deadline_are_bounded_and_incomplete_is_explicit(self):
        self.assertEqual(len(sample_times(120)),16)
        self.assertEqual(len(sample_times(.2)),4)
        renderer=Mock();result,strip=capture_motion(renderer,object(),'one',0,8,time.monotonic()-1)
        self.assertFalse(result['complete']);self.assertEqual(result['samples'],0)
        self.assertIn('unreviewed',result['error']);self.assertIsNone(strip)
        renderer._layers.assert_not_called()

    def test_artcheck_motion_is_opt_in_and_does_not_change_existing_frames(self):
        payload=self.payload('def draw(c,t,p):\n    c.grad("sky","cream")\n    c.rect(200,600,300,400,"blue")')
        legacy=check({**payload,'motion_review':False})['scenes'][0]
        temporal=check(payload)['scenes'][0]
        self.assertEqual(legacy['errors'],[]);self.assertNotIn('motion',legacy)
        self.assertEqual(len(legacy['frames']),2);self.assertEqual(legacy['frames'],temporal['frames'])
        self.assertNotEqual(temporal['frames'][0],temporal['frames'][1],'ordinary previews contain changing captions/progress')
        self.assertTrue(temporal['motion']['complete'])
        self.assertEqual(temporal['motion']['max_changed_fraction'],0)
        self.assertGreater(temporal['motion']['longest_hold_seconds'],2)
        strip=Image.open(io.BytesIO(base64.b64decode(temporal['motion_strip'])))
        self.assertEqual(strip.size,(720,342))

    def test_actor_only_motion_is_separate_and_not_itself_a_failure(self):
        portrait='def draw(c,t,p):\n    c.rect(-80,0,160,200,"blue")\n    c.circle(0,-80,70,"tan")'
        payload=self.payload('def draw(c,t,p):\n    c.grad("sky","cream")\n    c.person("guide",300+90*t,700,150)',cast=[{'name':'guide','portrait_code':portrait}])
        result=check(payload)['scenes'][0]
        self.assertEqual(result['errors'],[])
        self.assertGreater(result['motion']['max_changed_fraction'],.003)
        self.assertEqual(result['motion']['without_cast']['max_changed_fraction'],0)
        self.assertGreater(result['motion']['without_cast']['longest_hold_seconds'],2)
        self.assertIn('legitimately',result['motion']['without_cast']['note'])

    def test_temporal_samples_find_a_real_late_drawing_error_without_generic_fallback(self):
        payload=self.payload('unused');s=fake_timeline(payload['script'])[0]
        threshold=s['e']+.3-s['s']-.04
        payload['scenes'][0]['code']=f'def draw(c,t,p):\n    c.grad("sky","cream")\n    c.rect(200,600,300,400,"blue")\n    if t > {threshold}:\n        x = 1/0'
        result=check(payload)['scenes'][0]
        self.assertTrue(any('temporal render failed' in error for error in result['errors']))
        self.assertFalse(result['motion']['complete'])

if __name__=='__main__':unittest.main()
