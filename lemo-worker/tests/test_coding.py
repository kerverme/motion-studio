import json,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parents[2]/'worker')]
from lemo_worker.coding import response
from lemo_worker.catalog import enabled


class CodingTests(unittest.TestCase):
    def data(self):return {'id':'resp_fixture','status':'completed','usage':{'input_tokens':10,'output_tokens':20},'output':[{'content':[{'type':'output_text','text':json.dumps({'html':'<canvas></canvas>','description':'mock scene'})}]}]}
    def ctx(self,saved=None):
        queries=[]
        db=SimpleNamespace(one=lambda *a:{'provider_id':saved},q=lambda *a:queries.append(a))
        return SimpleNamespace(db=db,job={'id':'job'},pkg={'creative':{'model':'gpt-6.1-sol','reasoning':'medium'}}),queries
    def test_selected_brain_reference_photo_and_bounded_background_request(self):
        ctx,queries=self.ctx();r=SimpleNamespace(raise_for_status=lambda:None,json=self.data)
        with patch.dict('os.environ',{'OPENAI_API_KEY':'mock-only'}),patch('lemo_worker.coding.requests.post',return_value=r) as post:
            code,usage,rid=response(ctx,'reservation','draw this scene',[{'reference_image':'data:image/png;base64,bW9jaw=='}])
            body=post.call_args.kwargs['json'];self.assertEqual(body['model'],'gpt-6.1-sol');self.assertTrue(body['background']);self.assertEqual(body['max_output_tokens'],12000)
            self.assertEqual(body['input'][0]['content'][1]['type'],'input_image');self.assertEqual(rid,'resp_fixture');self.assertEqual(len(queries),1)
    def test_saved_response_resumes_get_without_second_post(self):
        ctx,_=self.ctx('resp_fixture');r=SimpleNamespace(raise_for_status=lambda:None,json=self.data)
        with patch.dict('os.environ',{'OPENAI_API_KEY':'mock-only'}),patch('lemo_worker.coding.requests.get',return_value=r) as get,patch('lemo_worker.coding.requests.post') as post:
            response(ctx,'reservation','same scene');self.assertEqual(get.call_count,1);post.assert_not_called()
    def test_unapproved_default_never_claims_jobs(self):
        with patch.dict('os.environ',{},clear=True):self.assertFalse(enabled())


if __name__=='__main__':unittest.main()
