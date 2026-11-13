import subprocess, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from PIL import ImageFont

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'worker'),str(ROOT/'lemo-worker')]
from lemo_worker import subtitles, render, main


class SubtitleTests(unittest.TestCase):
    def timing(self):
        words=[{'w':'ต้นไม้','s':0,'e':.3},{'w':'กางร่ม','s':.3,'e':.8}]
        return {'timeline':[{'id':'one','s':0,'e':.8,'phrases':[{'text':'ต้นไม้กางร่ม','s':0,'e':.8,'words':words}]}],'end':1}

    def test_native_portrait_and_word_highlight_do_not_stretch_thai(self):
        text=subtitles.ass(self.timing())
        self.assertIn('PlayResX: 1080\nPlayResY: 1920',text)
        self.assertIn('Kanit ExtraBold',text)
        self.assertIn(r'{\1c&H28DEFF&}ต้นไม้{\1c&HFFFFFF&}กางร่ม',text)
        self.assertIn('0:00:00.30,0:00:01.00',text)

    def test_long_thai_text_stays_in_two_line_pages_and_never_executes_ass(self):
        font=ImageFont.truetype(str(subtitles.FONT),subtitles.TEXT_SIZE)
        words=[{'w':'สวัสดี','s':i*.1,'e':(i+1)*.1} for i in range(40)]
        pages=subtitles.pages(words,font)
        self.assertGreater(len(pages),1)
        self.assertEqual([w for page in pages for line in page for w in line],words)
        for page in pages:
            self.assertLessEqual(len(page),2)
            for line in page:self.assertLessEqual(font.getlength(''.join(w['w'] for w in line)),subtitles.MAX_WIDTH)
        self.assertNotIn(r'{\pos',subtitles.literal('{\\pos(0,0)}\nDialogue:'))
        self.assertNotIn('\n',subtitles.literal('a\nb'))
        with self.assertRaisesRegex(ValueError,'safe width'):
            subtitles.pages([{'w':'A'*1000}],font)

    def test_real_ffmpeg_uses_bundled_font_at_native_aspect_and_safe_position(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)
            raw=folder/'raw.mp4'
            subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=black:s=1080x1920:r=30:d=1','-threads','2','-c:v','libx264','-preset','ultrafast',str(raw)],check=True)
            out=subtitles.burn(str(raw),self.timing(),str(folder/'captions'))
            pixels=subprocess.check_output(['ffmpeg','-v','error','-ss','0.5','-i',out,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-threads','1','pipe:1'])
            rgb=np.frombuffer(pixels,dtype=np.uint8).reshape(1920,1080,3)
            yy,xx=np.where((rgb[:,:,0]>180)&(rgb[:,:,1]>150)&(rgb[:,:,2]<100))
            expected=ImageFont.truetype(str(subtitles.FONT),74).getbbox('ต้นไม้กางร่ม')
            # Default SRT PlayRes on a portrait frame stretches the glyph height ~2.4x.
            self.assertAlmostEqual((xx.max()-xx.min())/(yy.max()-yy.min()),(expected[2]-expected[0])/(expected[3]-expected[1]),delta=.6)
            self.assertGreater(yy.min(),1536);self.assertLess(yy.max(),1760)
            self.assertGreater(xx.min(),100);self.assertLess(xx.max(),980)

    def test_missing_cached_scene_fails_without_provider_generation(self):
        ctx=SimpleNamespace(r={'CAPTION_REPAIR':{'version':subtitles.VERSION},'GENERATING_AUDIO':{'narration_key':'audio'},'BUILDING_TIMELINE':{'timeline_key':'timeline'},'LEMO_RENDER':{'scenes':[]}},pkg={'creative':{'selection':{'plan':{'scenes':[{'seg':'missing'}]}}}})
        with patch.object(render.pipeline,'load_timeline',return_value=self.timing()),patch.object(render,'generate_scene') as code,patch.object(render,'remote_render') as executor,patch.object(render.pipeline,'stage_audio') as audio:
            with self.assertRaisesRegex(RuntimeError,'Cached scene missing'):render.stage_recompose(ctx)
            code.assert_not_called();executor.assert_not_called();audio.assert_not_called()

    def test_caption_repair_only_runs_local_composition_qa_and_delivery(self):
        with tempfile.TemporaryDirectory() as d:
            results={'CAPTION_REPAIR':{'version':subtitles.VERSION}}
            job={'id':'job','episode_id':'episode','stage_results':results}
            db=SimpleNamespace(status=lambda *a:None,save_stage=lambda j,k,r:results.update({k:r}),q=lambda *a:None,release=lambda *a:None)
            ctx=SimpleNamespace(r=results,dir=d,prefix='jobs/job',db=db,job=job)
            with patch.object(main,'preflight') as preflight,patch.object(main.pipeline,'stage_audio') as audio,patch.object(main.pipeline,'stage_timeline') as timing,patch.object(main,'stage_render') as full,patch.object(main,'stage_recompose',return_value={'caption_version':subtitles.VERSION}) as repair,patch.object(main.pipeline,'stage_qa',return_value={}),patch.object(main.pipeline,'stage_upload',return_value={'video_url':'new-revision'}):
                main.run(ctx)
                preflight.assert_not_called();audio.assert_not_called();timing.assert_not_called();full.assert_not_called();repair.assert_called_once()
                self.assertTrue(ctx.prefix.endswith('/revisions/'+subtitles.VERSION))


if __name__=='__main__':unittest.main()
