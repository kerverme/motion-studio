"""Cover contract: actual delivered frame zero, continuous scene time, no extra intro."""
import json, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from engine import render, templates, artkit
from motion_worker.artcheck import check
from motion_worker.preview import scene_code
from motion_worker.rendering import first_frame

CODE = '''def draw(c,t,p):
    c.grad("sky", "cream")
    c.text(540,400,"เปิดเรื่องทันที",size=90)
    c.rect(350+100*t,700,300,400,"teal")
'''

class OpeningCoverTests(unittest.TestCase):
    def payload(self, code=CODE, enabled=True):
        return {'opening_frame_cover':enabled,'strict_art':True,'cast':[],
                'script':[{'id':'s1','text':'เปิดเรื่องทันที'}],
                'scenes':[{'seg':'s1','type':'custom','code':code}]}

    def test_preflight_includes_zero_and_rejects_delayed_blank(self):
        good=check(self.payload())['scenes'][0]
        self.assertEqual(good['errors'],[])
        self.assertEqual(len(good['frames']),3)
        self.assertNotEqual(good['frames'][0],good['frames'][1])
        bad=check(self.payload('def draw(c,t,p):\n    c.grad("white","white")\n    if t > 0.1:\n        c.rect(300,500,500,800,"teal")'))['scenes'][0]
        self.assertTrue(any('opening frame' in e for e in bad['errors']))
        self.assertEqual(len(check(self.payload(enabled=False))['scenes'][0]['frames']),2)

    def test_first_scene_time_starts_at_video_zero_but_cues_stay_aligned(self):
        from engine import core
        core.load_timeline([{'id':'s1','s':0.2,'e':1,'phrases':[]},{'id':'s2','s':1,'e':2,'phrases':[]}],2,'')
        spec={'opening_frame_cover':True,'strict_art':True,'scenes':[{'seg':s,'type':'custom','code':CODE} for s in ['s2','s1']]}
        scenes=templates.build_scenes(spec)
        captured=[]
        def capture(fn,img,t,p,hooks):captured.append((t,hooks['cue']('unknown')))
        with patch.object(artkit,'run',side_effect=capture):
            img=Image.new('RGBA',(1080,1920))
            scenes['s1'][0](img,None,0)
            scenes['s1'][0](img,None,0.1)
            scenes['s2'][0](img,None,1.1)
            templates.T_custom(img,None,0,'s1',{})
        self.assertEqual(captured[0],(0,0.2))
        self.assertEqual(captured[1],(0.1,0.2))
        self.assertAlmostEqual(captured[2][0],0.1)
        self.assertEqual(captured[3],(-0.2,0.0))

    def test_png_is_decoded_delivered_first_frame_with_no_added_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)
            spec={**self.payload(),'text':{'s1':'เปิดเรื่องทันที'}}
            (path/'scenes.py').write_text(scene_code(spec))
            mod=render.load_episode_module(str(path/'scenes.py'),[{'id':'s1','s':0.2,'e':1,'phrases':[]}],1,'','classic')
            self.assertNotEqual(render.frame(mod,0).tobytes(),render.frame(mod,1/30).tobytes())
            n=render.render_scene(mod,0,str(path/'clip.mp4'))
            self.assertEqual(n,30)
            from types import SimpleNamespace
            from motion_worker.pipeline import make_thumbnail
            ctx = SimpleNamespace(pkg={'thumbnail': {'mode':'opening_frame'}, 'cover': {'who':'ignored'}})
            make_thumbnail(ctx, {}, 1, str(path/'cover.png'), video=str(path/'clip.mp4'))
            with self.assertRaises(ValueError):
                make_thumbnail(ctx, {}, 1, str(path/'missing.png'))
            raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(path/'clip.mp4'),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'])
            self.assertEqual(Image.open(path/'cover.png').convert('RGB').tobytes(),raw)
            probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=nb_frames,duration','-of','json',str(path/'clip.mp4')]))['streams'][0]
            self.assertEqual(int(probe['nb_frames']),30)
            self.assertAlmostEqual(float(probe['duration']),1)

if __name__=='__main__':unittest.main()
