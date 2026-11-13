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
    def test_incomplete_response_keeps_usage_and_never_reposts_on_resume(self):
        ctx,queries=self.ctx('resp_fixture')
        r=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'status':'incomplete','incomplete_details':{'reason':'max_output_tokens'},'usage':{'output_tokens':12000}})
        with patch.dict('os.environ',{'OPENAI_API_KEY':'mock-only'}),patch('lemo_worker.coding.requests.get',return_value=r),patch('lemo_worker.coding.requests.post') as post:
            with self.assertRaisesRegex(RuntimeError,'max_output_tokens; output_tokens=12000'):response(ctx,'reservation','same scene')
            post.assert_not_called()
            self.assertEqual(json.loads(queries[0][1][0])['output_tokens'],12000)
    def test_configured_generation_limit_is_bounded(self):
        ctx,_=self.ctx();r=SimpleNamespace(raise_for_status=lambda:None,json=self.data)
        with patch.dict('os.environ',{'OPENAI_API_KEY':'mock-only','LEMO_CODE_MAX_OUTPUT_TOKENS':'24000'}),patch('lemo_worker.coding.requests.post',return_value=r) as post:
            response(ctx,'reservation','draw');self.assertEqual(post.call_args.kwargs['json']['max_output_tokens'],24000)
        with patch.dict('os.environ',{'OPENAI_API_KEY':'mock-only','LEMO_CODE_MAX_OUTPUT_TOKENS':'999999'}),patch('lemo_worker.coding.requests.post',return_value=r) as post:
            response(ctx,'reservation','draw');self.assertEqual(post.call_args.kwargs['json']['max_output_tokens'],32000)
    def test_failed_security_preflight_happens_before_paid_audio(self):
        from lemo_worker import main
        with patch.object(main,'preflight',side_effect=RuntimeError('unverified limits')),patch.object(main.pipeline,'stage_audio') as audio:
            with self.assertRaisesRegex(RuntimeError,'unverified'):main.run(SimpleNamespace())
            audio.assert_not_called()
    def test_preflight_requires_tls_and_matching_ready_executor(self):
        from lemo_worker.render import preflight
        ctx=SimpleNamespace(pkg={'creative':{'selection':{'selected':{'id':'dataviz'}}}})
        env={'OPENAI_API_KEY':'mock-only','ELEVENLABS_API_KEY':'mock-only','LEMO_EXECUTOR_URL':'https://executor.invalid','LEMO_EXECUTOR_TOKEN':'mock-only','LEMO_SANDBOX_IMAGE':'sha256:fixture'}
        with patch.dict('os.environ',env,clear=True),patch('lemo_worker.render.style_spec'),patch('lemo_worker.render.requests.get') as get:
            get.return_value=SimpleNamespace(status_code=503)
            with self.assertRaisesRegex(RuntimeError,'security readiness'):preflight(ctx)
            get.return_value=SimpleNamespace(status_code=200,json=lambda:{'ready':True,'image':'sha256:wrong'})
            with self.assertRaisesRegex(RuntimeError,'does not match'):preflight(ctx)
            get.return_value=SimpleNamespace(status_code=200,json=lambda:{'ready':True,'image':'sha256:fixture'})
            preflight(ctx)
            self.assertEqual(get.call_args.args[0],'https://executor.invalid/ready')
            self.assertEqual(get.call_args.kwargs['headers']['Authorization'],'Bearer mock-only')
            get.reset_mock()
            with patch.dict('os.environ',{'LEMO_EXECUTOR_URL':'http://executor.invalid'}):
                with self.assertRaisesRegex(RuntimeError,'TLS'):preflight(ctx)
            get.assert_not_called()


if __name__=='__main__':unittest.main()
