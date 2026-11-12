import base64, copy, datetime as dt, json, os, shutil, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import requests
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from motion_worker import text_video as tv, pipeline, config, audio
from motion_worker.storage import LocalStorage
from motion_worker.db import DB


def fixture():
    inp={'duration':60,'video_model':'h3_max','resolution':'480P'}
    shots=[{'id':f'shot_{i+1:02d}','narration':'เรือลำน้อยลอยไปตามแม่น้ำและค่อยค่อยกลับบ้าน','visual_prompt':'A red paper boat moves along the river with a tracking camera.','end_frame':'The paper boat rests beside a warm lantern.'} for i in range(4)]
    plan={'visual_bible':'Warm watercolor animation with a consistent red paper boat.','shots':shots}
    approval={'id':'00000000-0000-4000-8000-000000000001','plan_hash':tv.digest({'input':inp,'plan':plan}),'approved_at':dt.datetime.now(dt.timezone.utc).isoformat(),'valid_until':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=1)).isoformat(),'voice_id':'test-voice','voice_model':'eleven_v3',
              'fal':[{'slot':'fal:'+s['id'],'endpoint':tv.MODELS['h3_max'][bool(i)],'usd':.8} for i,s in enumerate(shots)],
              'eleven':[{'slot':'eleven:'+s['id'],'credits':100} for s in shots],
              'fal_rates':[{'endpoint_id':ep,'unit':'seconds','unit_price':.035,'currency':'USD'} for ep in tv.MODELS['h3_max'][:2]]}
    pkg={'topic':'นิทานเรือ','title_th':'เรือลำน้อย','voice':{'voice_id':'test-voice'},'text_video':{'version':1,'input':inp,'plan':plan,'approval':approval},'script':[{'id':s['id'],'text':s['narration']} for s in shots]}
    return {'id':'test-text-video','episode_id':'test-episode','package':pkg,'stage_results':{},'budget_credits':500,'used_credits':0,'status':'GENERATING_AUDIO'}


class FakeDB:
    def __init__(self,job):self.job=job;self.calls=[];self.events=[]
    def one(self,sql,args=()):
        if sql.startswith('SELECT status FROM jobs'):return {'status':self.job['status']}
        if sql.startswith('SELECT * FROM text_video_calls'):
            return next((copy.deepcopy(c) for c in reversed(self.calls) if c['slot']==args[1]),None)
        if sql.startswith('INSERT INTO text_video_calls'):
            if any(c['slot']==args[1] and c['approval_id']==args[2] for c in self.calls):return None
            row=dict(zip(['job_id','slot','approval_id','provider','input_hash'],args));row.update(status='submitting',data={});self.calls.append(row);return copy.deepcopy(row)
        raise AssertionError(sql)
    def q(self,sql,args=()):
        if sql.startswith('WITH changed AS'):
            status,data,rid,jobid,slot,aid,credits,_=args
            row=next(c for c in self.calls if c['slot']==slot and c['approval_id']==aid)
            if row['status']!='done':row.update(status=status,data=json.loads(data),request_id=rid or row.get('request_id'))
        return []
    def save_stage(self,job,stage,result):job['stage_results'][stage]=result
    def status(self,job,status,stage,progress,message=None,data=None):job['status']=status;self.events.append(message)
    def event(self,*args,**kwargs):pass
    def asset(self,*args,**kwargs):pass


class Store(LocalStorage):
    def signed_url(self,key,expires):
        assert self.exists(key)
        return 'https://example.invalid/frame/'+key


class Response:
    def __init__(self,data,status=200,headers=None):self.data=data;self.status_code=status;self.ok=status<400;self.headers=headers or {}
    def json(self):return self.data
    def raise_for_status(self):
        if not self.ok:raise requests.HTTPError(str(self.status_code))


class TextVideoTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.old=config.WORKDIR;config.WORKDIR=self.tmp.name+'/work';self.job=fixture();self.db=FakeDB(self.job);self.store=Store(self.tmp.name+'/bucket');self.ctx=pipeline.Ctx(self.db,self.store,self.job)
    def tearDown(self):config.WORKDIR=self.old;self.tmp.cleanup()

    def test_unapproved_changed_expired_or_cancelled_cannot_reserve_paid_call(self):
        a=self.job['package']['text_video']['approval'];a['approved_at']=None
        with self.assertRaises(tv.ApprovalRequired):tv.reserve(self.ctx,'fal:shot_01','fal',{})
        self.assertEqual(len(self.db.calls),0)
        a['approved_at']='2026-01-01';a['valid_until']='2000-01-01T00:00:00+00:00'
        with self.assertRaises(tv.ApprovalRequired):tv.reserve(self.ctx,'fal:shot_01','fal',{})
        a['valid_until']='2099-01-01T00:00:00+00:00';self.job['status']='CANCELLED'
        with self.assertRaises(tv.ApprovalRequired):tv.reserve(self.ctx,'fal:shot_01','fal',{})
        self.job['status']='GENERATING_AUDIO';self.job['package']['text_video']['plan']['shots'][0]['narration']='changed'
        with self.assertRaises(tv.ApprovalRequired):tv.validate(self.ctx)

    def test_lost_paid_response_is_never_posted_again_even_after_new_approval(self):
        row,send=tv.reserve(self.ctx,'fal:shot_01','fal',{'prompt':'one'});self.assertTrue(send)
        with patch.object(tv.requests,'post',side_effect=requests.Timeout()) as post:
            with self.assertRaises(tv.ApprovalRequired):tv.paid_post(self.ctx,row,'https://queue.fal.run/test',{}, {},1)
            for _ in range(2):
                with self.assertRaises(tv.ApprovalRequired):tv.reserve(self.ctx,'fal:shot_01','fal',{'prompt':'one'})
            self.job['package']['text_video']['approval']['id']='00000000-0000-4000-8000-000000000002'
            with self.assertRaises(tv.ApprovalRequired):tv.reserve(self.ctx,'fal:shot_01','fal',{'prompt':'one'})
            self.assertEqual(post.call_count,1)
        self.assertEqual(self.db.calls[0]['status'],'unknown')

    def test_rejected_request_needs_new_approval_and_successful_calls_are_reused(self):
        row,_=tv.reserve(self.ctx,'fal:shot_01','fal',{'prompt':'one'});tv.update(self.ctx,row,'failed',{'http_status':422})
        with self.assertRaises(tv.ApprovalRequired):tv.reserve(self.ctx,'fal:shot_01','fal',{'prompt':'one'})
        self.job['package']['text_video']['approval']['id']='00000000-0000-4000-8000-000000000002'
        row,send=tv.reserve(self.ctx,'fal:shot_01','fal',{'prompt':'one'});self.assertTrue(send);tv.update(self.ctx,row,'done',{'video_key':'saved'})
        reused,send=tv.reserve(self.ctx,'fal:shot_01','fal',{'prompt':'one'});self.assertFalse(send);self.assertEqual(reused['data']['video_key'],'saved')

    def test_provider_queue_host_and_changed_price_fail_closed(self):
        for url in ['http://queue.fal.run/a/requests/x','https://evil.example/requests/x','https://queue.fal.run.evil.example/requests/x']:
            with self.assertRaises(tv.ApprovalRequired):tv.queue_url(url)
        with patch.dict(os.environ,{'FAL_KEY':'test-only'}),patch.object(tv.requests,'get',return_value=Response({'prices':[{'endpoint_id':tv.MODELS['h3_max'][0],'unit':'seconds','unit_price':.1,'currency':'USD'}]})):
            with self.assertRaises(tv.ApprovalRequired):tv.verify_price(self.ctx,tv.MODELS['h3_max'][0])

    def test_v3_omits_unsupported_stitching_and_reuses_persisted_audio(self):
        shots=self.job['package']['text_video']['plan']['shots']
        chars=list(shots[0]['narration']);n=len(chars)
        response=Response({'audio_base64':base64.b64encode(b'persisted audio fixture').decode(),'alignment':{'characters':chars,'character_start_times_seconds':[i/n for i in range(n)],'character_end_times_seconds':[(i+1)/n for i in range(n)]}})
        # A pre-fix HTTP 400 has the same logical identity as the repaired request.
        legacy={'text':shots[0]['narration'],'model_id':'eleven_v3','language_code':'th','voice_settings':{'stability':.5,'similarity_boost':.75},'voice_id':'test-voice','next_text':shots[1]['narration']}
        old,_=tv.reserve(self.ctx,'eleven:shot_01','eleven',legacy)
        tv.update(self.ctx,old,'failed',{'http_status':400})
        with patch.object(tv.requests,'post',return_value=response) as post:
            with self.assertRaises(tv.ApprovalRequired):tv.narration(self.ctx,shots[0],0)
            post.assert_not_called()
            self.job['package']['text_video']['approval']['id']='00000000-0000-4000-8000-000000000002'
            for i,shot in enumerate(shots):
                first=tv.narration(self.ctx,shot,i)
                self.assertEqual(tv.narration(self.ctx,shot,i),first)
            self.assertEqual(post.call_count,4)
            for call in post.call_args_list:
                payload=call.kwargs['json']
                self.assertEqual(payload['model_id'],'eleven_v3')
                self.assertNotIn('previous_text',payload)
                self.assertNotIn('next_text',payload)

    def test_provider_error_is_actionable_and_credentials_are_redacted(self):
        row,_=tv.reserve(self.ctx,'eleven:shot_01','eleven',{})
        response=Response({'detail':{'status':'unsupported_model','message':'Unsupported next_text; key=private-test-key'}},400,{'request-id':'rejected-request'})
        with patch.object(tv.requests,'post',return_value=response):
            with self.assertRaisesRegex(tv.ApprovalRequired,'unsupported_model') as caught:
                tv.paid_post(self.ctx,row,'https://api.elevenlabs.io/test',{'xi-api-key':'private-test-key'},{},1)
        self.assertNotIn('private-test-key',str(caught.exception))
        self.assertNotIn('private-test-key',json.dumps(self.db.calls))
        self.assertEqual(self.db.calls[0]['request_id'],'rejected-request')
        self.assertEqual(self.db.calls[0]['status'],'failed')

    def test_cancelled_jobs_cannot_reappear_as_ready_or_failed(self):
        # The DB conditional update lost to cancellation: do not overwrite the episode or emit a success.
        db=object.__new__(DB);job={**self.job,'kind':'text_video'}
        with patch.object(db,'q',return_value=[]) as query:
            with self.assertRaises(tv.JobCancelled):db.status(job,'READY_TO_POST',message='done')
            self.assertEqual(query.call_count,1)
            db.fail(job,'provider failed after cancellation',final=True)
            self.assertEqual(query.call_count,2)
            self.assertEqual(job['status'],'GENERATING_AUDIO')

    @unittest.skipUnless(os.environ.get('TEXT_VIDEO_FULL_TEST')=='1','Run explicitly: real 60-second FFmpeg assembly with synthetic provider fixtures')
    def test_real_60_second_assembly_with_exact_frame_chaining_and_no_duplicate_spend(self):
        raw=self.tmp.name+'/fixture.mp4';tone=self.tmp.name+'/voice.mp3'
        tv.ffmpeg(['-f','lavfi','-i','testsrc2=size=270x480:rate=30:duration=15','-an','-c:v','libx264','-preset','ultrafast','-threads','2',raw])
        tv.ffmpeg(['-f','lavfi','-i','sine=frequency=220:duration=5','-c:a','libmp3lame',tone]);voice=base64.b64encode(Path(tone).read_bytes()).decode();posts=[]
        def post(url,headers,json,**kwargs):
            posts.append((url,json));self.assertTrue(self.job['package']['text_video']['approval']['approved_at'])
            if 'elevenlabs' in url:
                chars=list(json['text']);n=len(chars);return Response({'audio_base64':voice,'alignment':{'characters':chars,'character_start_times_seconds':[i*4.7/n for i in range(n)],'character_end_times_seconds':[(i+1)*4.7/n for i in range(n)]}})
            idx=len([u for u,_ in posts if 'queue.fal.run' in u]);root=f'https://queue.fal.run/minimax/h3-max/requests/req-{idx}'
            return Response({'request_id':f'req-{idx}','status_url':root+'/status','response_url':root})
        def get(url,**kwargs):
            if 'models/pricing' in url:return Response({'prices':self.job['package']['text_video']['approval']['fal_rates']})
            return Response({'status':'COMPLETED'}) if url.endswith('/status') else Response({'video':{'url':'https://v3.fal.media/fixture.mp4'}})
        def upload(ctx):
            self.assertTrue(Path(ctx.path('final.mp4')).exists());return {'episode_number':999,'storage':'fixture','files':[]}
        with patch.dict(os.environ,{'FAL_KEY':'test-only'}),patch.object(tv.requests,'post',side_effect=post),patch.object(tv.requests,'get',side_effect=get),patch.object(tv,'download_video',side_effect=lambda url,path:shutil.copyfile(raw,path)),patch.object(pipeline,'stage_upload',side_effect=upload):
            result=tv.run(self.ctx);self.assertEqual(result['episode_number'],999);self.assertEqual(len(posts),8)
            fal=[payload for url,payload in posts if 'queue.fal.run' in url];self.assertNotIn('image_url',fal[0]);self.assertEqual(fal[0]['aspect_ratio'],'9:16')
            for i in range(1,4):self.assertTrue(fal[i]['image_url'].endswith(f'shot_{i:02d}_end.png'));self.assertNotIn('aspect_ratio',fal[i])
            self.assertEqual(len([c for c in self.db.calls if c['status']=='done']),8)
            prev=None
            for i,s in enumerate(self.job['package']['text_video']['plan']['shots']):
                tv.narration(self.ctx,s,i);prev=tv.fal_shot(self.ctx,s,i,prev)['frame_key']
            self.assertEqual(len(posts),8,'resume uses stored media, without any paid POST')
        info=audio.ffprobe(self.ctx.path('final.mp4'));self.assertAlmostEqual(float(info['format']['duration']),60,places=1);self.assertEqual(self.job['status'],'READY_TO_POST')
        out=os.environ.get('TEXT_VIDEO_TEST_OUTPUT')
        if out:Path(out).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(self.ctx.path('final.mp4'),out)

if __name__=='__main__':unittest.main()
