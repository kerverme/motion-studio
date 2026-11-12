import json,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'worker'))
from motion_worker.pipeline import write_docs


class ExportTests(unittest.TestCase):
    def test_delivery_manifest_preserves_model_style_cost_unknowns_and_sound_decisions(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/nik.json').read_text())
        ctx=SimpleNamespace(pkg={'title_th':fixture['topic'],'topic':fixture['topic'],'script':fixture['script'],'storyboard':fixture['creative']['scenes'],'sources':fixture['sources'],'creative':{'engine':'lemo','model':'gpt-6.1-sol','selection':{'plan':fixture['creative']}}},job={'id':'mock-job'},r={'GENERATING_AUDIO':{'narration_manifest':[{'cache_hit':True,'meta':{'model_id':'eleven_v4','mock':True}}],'sfx_manifest':[{'model_id':'eleven_text_to_sound_v3','cache_hit':True}]}},db=SimpleNamespace(q=lambda *a:[{'category':'narration','model':'eleven_v4','reserved_usd':1,'actual_usd':None,'status':'complete','usage':{'mock':True}}]))
        timing={'timeline':[{'id':s['id'],'s':i*2,'e':i*2+1.8,'phrases':[]} for i,s in enumerate(fixture['script'])],'end':8,'cues':[]}
        with tempfile.TemporaryDirectory() as folder:
            files=write_docs(ctx,timing,1,folder)
            for name in ['cost-summary.json','style-director.json','sound-design.json','narration-metadata.json','render-metadata.json','storyboard.json','sources.json']:self.assertIn(name,files)
            self.assertEqual(json.loads(Path(files['cost-summary.json']).read_text())['unreconciled'],1)
            text=Path(files['creative-manifest.json']).read_text();self.assertIn('gpt-6.1-sol',text);self.assertNotIn('reference_image',text)


if __name__=='__main__':unittest.main()
