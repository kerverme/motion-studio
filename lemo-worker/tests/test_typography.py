import json, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'worker'),str(ROOT/'lemo-worker')]
from lemo_worker import typography, render, main

LEGACY='''<!doctype html><html><head></head><body><script>
function text(s,x,y,size,fill=I,stroke=null,max=1000){c.font='900 '+size+'px "Noto Sans Thai"';c.scale(.5,1);c.fillText(s,x,y)}
function title(){text('หัวเรื่อง',545,433,92,O,I,874);text('หัวเรื่อง',540,423,92,W,I,874);text('ป้าย',868,684,35,I,null,239)}
</script></body></html>'''


class TypographyTests(unittest.TestCase):
    def test_global_font_helper_import_is_bound_without_changing_real_library_imports(self):
        source='''<html><head></head><body><script type="module">
import { MotionText } from '/core/lib.js';
await MotionText.ready;
window.render = () => MotionText.draw(ctx, 'หัวเรื่อง', 540, 400);
</script></body></html>'''
        prepared=typography.prepare_source(source)
        self.assertIn('const MotionText = window.MotionText;',prepared)
        self.assertNotIn("import { MotionText }",prepared)
        self.assertIn("window.render = () => MotionText.draw(ctx, 'หัวเรื่อง', 540, 400);",prepared)
        mixed=source.replace("import { MotionText } from '/core/lib.js';",'import { clamp, MotionText as Text, lerp } from "/core/lib.js";')
        bound=typography.bind_motion_text_imports(mixed)
        self.assertIn("import { clamp, lerp } from '/core/lib.js';",bound)
        self.assertIn('const Text = window.MotionText;',bound)
        self.assertEqual(typography.bind_motion_text_imports(bound),bound)
        other=source.replace('/core/lib.js','/other.js')
        self.assertEqual(typography.bind_motion_text_imports(other),other)

    def test_legacy_title_and_every_label_use_the_trusted_helper_once(self):
        clean=typography.repair_source(LEGACY)
        self.assertEqual(clean.count("text('หัวเรื่อง'"),1)
        self.assertIn("text('ป้าย'",clean)
        self.assertIn('MotionText.draw(c,s,x,y',clean)
        self.assertIn('stroke||fill,null,max',clean,'use the contrasting ink as a solid fill instead of an outlined hollow headline')
        self.assertNotIn('c.scale(.5,1)',clean)
        self.assertEqual(typography.repair_source(clean),clean)
        far=LEGACY.replace('545,433','500,800')
        self.assertEqual(typography.repair_source(far).count("text('หัวเรื่อง'"),2,'unrelated labels are not deduplicated')

    def test_offline_font_loading_precedes_scene_and_missing_assets_fail_closed(self):
        prepared=typography.prepare_source(typography.repair_source(LEGACY))
        self.assertLess(prepared.index('new FontFace'),prepared.index('function title'))
        self.assertLess(prepared.index('<meta charset="utf-8">'),1024)
        self.assertIn('SIL OPEN FONT LICENSE',prepared)
        self.assertNotIn('__KANIT_',prepared)
        self.assertLess(len(prepared.encode()),750000)
        with self.assertRaisesRegex(ValueError,'already contains'):typography.prepare_source(prepared)
        with self.assertRaisesRegex(ValueError,'Unsupported scene text helper'):typography.repair_source('<html><head></head></html>')
        with patch.object(typography,'FD','/missing-fonts'):
            with self.assertRaises(FileNotFoundError):typography.prepare_source(LEGACY)

    def test_source_repair_checkpoints_each_scene_without_model_or_audio_requests(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);source=folder/'original.html';source.write_text(LEGACY)
            original={'seg':'one','identity':'original','source_key':str(source),'video_key':'old-video','provenance':{'model':'selected-model'}}
            stages={'TYPOGRAPHY_REPAIR':{'version':typography.VERSION,'previous':{'LEMO_RENDER':{'scenes':[original]}}},'GENERATING_AUDIO':{'narration_key':'saved'},'BUILDING_TIMELINE':{'timeline_key':'saved'}}
            job={'id':'job','stage_results':stages};saved={}
            def path(*parts):
                p=folder.joinpath(*parts);p.parent.mkdir(parents=True,exist_ok=True);return str(p)
            def save(kind,local,key=None,**kw):
                key=key or 'saved/'+Path(local).name;saved[key]=str(local);return key
            ctx=SimpleNamespace(r=stages,job=job,dir=d,prefix='jobs/job/revisions/test',pkg={'creative':{'selection':{'plan':{'scenes':[{'seg':'one'}]}}}},path=path,fetch=lambda key,_:saved.get(key,key),save=save,store=SimpleNamespace(exists=lambda key:True),db=SimpleNamespace(save_stage=lambda j,k,v:stages.update({k:v}),status=lambda *a:None))
            def fake_render(spec,location):
                self.assertIn('Motion Kanit',spec['html']);self.assertIn('MotionText.draw',spec['html'])
                self.assertEqual(spec['duration'],1)
                p=Path(location);p.mkdir(parents=True,exist_ok=True)
                for name in ['video.mp4','preview-0.png','preview-1.png','preview-2.png']: (p/name).write_bytes(b'fixture')
                (p/'metadata.json').write_text(json.dumps({'fixture':True}))
            with patch.object(render.pipeline,'load_timeline',return_value={'timeline':[{'id':'one','s':0}],'end':1}),patch.object(render,'compose_video',return_value={'fixture':True}),patch.object(render,'generate_scene') as code,patch.object(render.pipeline,'stage_audio') as audio,patch.object(render,'remote_render',side_effect=fake_render) as executor:
                render.stage_retype(ctx,render=executor)
                render.stage_retype(ctx,render=executor)
                self.assertEqual(executor.call_count,1)
                code.assert_not_called();audio.assert_not_called()
                item=stages['LEMO_RENDER']['scenes'][0]
                self.assertEqual(item['typography_version'],typography.VERSION)
                self.assertEqual(item['original_source_key'],str(source))
                self.assertEqual(item['provenance'],original['provenance'])

    def test_text_repair_requires_the_sandbox_gate_but_skips_paid_stages(self):
        with tempfile.TemporaryDirectory() as d:
            stages={'TYPOGRAPHY_REPAIR':{'version':typography.VERSION}}
            job={'id':'job','episode_id':'episode','stage_results':stages}
            ctx=SimpleNamespace(r=stages,job=job,dir=d,prefix='jobs/job',db=SimpleNamespace(status=lambda *a:None,save_stage=lambda j,k,r:stages.update({k:r}),q=lambda *a:None,release=lambda *a:None))
            with patch.object(main,'preflight') as preflight,patch.object(main,'stage_retype',return_value={}) as retype,patch.object(main,'stage_render') as generate,patch.object(main.pipeline,'stage_audio') as audio,patch.object(main.pipeline,'stage_qa',return_value={}),patch.object(main.pipeline,'stage_upload',return_value={}):
                main.run(ctx);preflight.assert_called_once();retype.assert_called_once();generate.assert_not_called();audio.assert_not_called()


if __name__=='__main__':unittest.main()
