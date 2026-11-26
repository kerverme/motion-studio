import concurrent.futures, json, os, sys, threading, time, unittest, uuid
import tempfile,subprocess
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'worker'))
from motion_worker import config
from motion_worker.db import DB
from motion_worker.creative_ledger import Ledger,AmbiguousCall


@unittest.skipUnless(os.environ.get('LEMO_TEST_DATABASE_URL'),'isolated PostgreSQL test database required')
class LedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        config.DATABASE_URL=os.environ['LEMO_TEST_DATABASE_URL']
        with psycopg.connect(config.DATABASE_URL,autocommit=True) as c:
            if c.execute('SELECT current_database()').fetchone()[0]!='lemo_test':raise RuntimeError('Refusing a non-test database')
            for path in sorted((ROOT/'api/migrations').glob('*.sql')):
                if not c.execute("SELECT to_regclass('schema_migrations')").fetchone()[0] or not c.execute('SELECT 1 FROM schema_migrations WHERE name=%s',(path.name,)).fetchone():
                    c.execute(path.read_text());c.execute('INSERT INTO schema_migrations(name) VALUES(%s)',(path.name,))
    def setUp(self):
        self.db=DB();draft=self.db.one("INSERT INTO drafts(topic) VALUES('ledger isolated fixture') RETURNING id")
        self.job=self.db.one("INSERT INTO jobs(kind,status,package) VALUES('lemo','NEW',%s::jsonb) RETURNING *",(json.dumps({'creative':{'test':True}}),))
        self.db.q('INSERT INTO creative_approvals(draft_id,revision,quote,allocations,max_usd,unknown_ack,job_id) VALUES(%s,%s,\'{}\',%s::jsonb,1,true,%s)',(draft['id'],str(uuid.uuid4()),json.dumps({'narration':1,'coding':1}),self.job['id']))
        self.ctx=SimpleNamespace(db=self.db,job=self.job)
    def tearDown(self):self.db.conn.close()
    def test_busy_then_ready_reuses_audio_and_finishes_same_job(self):
        from lemo_worker import main
        self.db.q('CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING DEFAULTS)')
        saved={'GENERATING_AUDIO':{'narration_key':'fixture.mp3'},'BUILDING_TIMELINE':{'timeline_key':'fixture.json'}}
        package={'creative':{'selection':{'selected':{'id':'dataviz'}}}}
        self.db.q("""INSERT INTO jobs(id,kind,status,stage_results,package) VALUES(%s,'lemo','NEW',%s,%s)""",
                  (self.job['id'],json.dumps(saved),json.dumps(package)))
        env={'LEMO_STYLE_LIBRARY':'cloudbath-original-v1','LEMO_ORIGINAL_STYLE_VERIFIED':'true',
             'LEMO_EXECUTOR_URL':'https://executor.invalid','LEMO_EXECUTOR_TOKEN':'fixture','LEMO_SANDBOX_IMAGE':'fixture',
             'OPENAI_API_KEY':'fixture','ELEVENLABS_API_KEY':'fixture'}
        answers=[SimpleNamespace(status_code=409,json=lambda:{'code':'executor_busy'}),
                 SimpleNamespace(status_code=200,json=lambda:{'ready':True,'image':'fixture'})]
        with tempfile.TemporaryDirectory() as workdir, patch.object(config,'WORKDIR',workdir),patch.dict(os.environ,env), \
             patch('lemo_worker.render.requests.get',side_effect=answers) as checks, \
             patch.object(main.pipeline,'stage_audio') as audio,patch.object(main.pipeline,'stage_timeline') as timeline, \
             patch.object(main,'stage_render',return_value={'final_key':'fixture.mp4'}) as render, \
             patch.object(main.pipeline,'stage_qa',return_value={'ok':True}),patch.object(main.pipeline,'stage_upload',return_value={'ok':True}):
            first=main.claim_job(self.db,'worker')
            main.run_claimed_job(self.db,None,first)
            render.assert_not_called()
            self.assertIsNone(main.claim_job(self.db,'worker'))
            self.db.q("UPDATE jobs SET locked_until=now()-interval '1 second'")
            second=main.claim_job(self.db,'worker')
            self.assertIsNotNone(second)
            main.run_claimed_job(self.db,None,second)
            self.assertEqual(first['id'],second['id'])
            self.assertEqual(checks.call_count,2)
            self.assertEqual(self.db.one('SELECT status FROM jobs WHERE id=%s',(second['id'],))['status'],'READY_TO_POST')
            audio.assert_not_called()
            timeline.assert_not_called()
            render.assert_called_once()
            self.assertEqual(second['stage_results']['GENERATING_AUDIO'],saved['GENERATING_AUDIO'])

    def test_readiness_backoff_keeps_approval_and_stops_at_attempt_limit(self):
        from lemo_worker import main
        self.db.q('CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING DEFAULTS)')
        checkpoint={'GENERATING_AUDIO':{'narration_key':'saved/audio.mp3'}}
        self.db.q("""INSERT INTO jobs(id,kind,status,stage_results,max_attempts)
            VALUES(%s,'lemo','NEW',%s::jsonb,2)""",(self.job['id'],json.dumps(checkpoint)))
        with patch.object(main.pipeline,'Ctx',return_value=self.ctx), \
             patch.object(main,'preflight',side_effect=main.ExecutorTemporarilyUnavailable('runtime unavailable')), \
             patch.object(main.pipeline,'stage_audio') as audio, patch.object(main,'stage_render') as render:
            job=main.claim_job(self.db,'fixture')
            main.run_claimed_job(self.db,None,job)
            paused=self.db.one('SELECT status,locked_until>now() AS delayed FROM jobs WHERE id=%s',(job['id'],))
            self.assertEqual(paused,{'status':'NEW','delayed':True})
            self.assertIsNone(main.claim_job(self.db,'second-worker'))
            self.db.q("UPDATE jobs SET locked_until=now()-interval '1 second'")
            again=main.claim_job(self.db,'second-worker')
            self.assertEqual(again['id'],job['id'])
            self.assertEqual(again['stage_results'],checkpoint)
            self.assertEqual(again['attempts'],2)
            main.run_claimed_job(self.db,None,again)
            self.assertEqual(self.db.one('SELECT status FROM jobs WHERE id=%s',(job['id'],))['status'],'FAILED')
            self.assertIsNone(main.claim_job(self.db,'fixture'))
            audio.assert_not_called()
            render.assert_not_called()
        self.assertEqual(self.db.one('SELECT count(*) AS n FROM creative_approvals WHERE job_id=%s',(job['id'],))['n'],1)
        self.assertEqual(self.db.one('SELECT count(*) AS n FROM creative_calls WHERE job_id=%s',(job['id'],))['n'],0)

    def test_claim_survives_column_migration_and_resumes_saved_stages(self):
        from lemo_worker import main
        # Force server-side preparation on a long-lived connection. Only the temp queue is altered.
        self.db.conn.prepare_threshold = 0
        self.db.q('CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING DEFAULTS)')
        self.assertIsNone(main.claim_job(self.db,'test-worker'))
        self.db.q('ALTER TABLE jobs ADD COLUMN migration_fixture text')
        saved = {'GENERATING_AUDIO':{'narration_key':'immutable/audio.mp3'},
                 'BUILDING_TIMELINE':{'timeline_key':'immutable/timeline.json'},
                 'RENDERING':{'final_key':'immutable/final.mp4'}}
        self.db.q("INSERT INTO jobs(id,kind,status,stage_results) VALUES(%s,'lemo','QUALITY_CHECK',%s::jsonb)",
                  (self.job['id'],json.dumps(saved)))
        job = main.claim_job(self.db,'test-worker')
        self.assertEqual(job['stage_results'],saved)
        self.assertEqual(job['attempts'],1)
        self.assertIsNone(main.claim_job(self.db,'other-worker'))
        with patch.object(main,'preflight'), patch.object(main.pipeline,'stage_audio') as audio, patch.object(main,'stage_render') as render:
            with patch.object(main.pipeline,'stage_qa',side_effect=ValueError('reached QA')):
                with self.assertRaisesRegex(ValueError,'reached QA'):
                    main.run(SimpleNamespace(r=job['stage_results'],db=self.db,job=job))
            audio.assert_not_called()
            render.assert_not_called()

    def test_concurrent_duplicate_has_exactly_one_provider_call(self):
        count=0;lock=threading.Lock()
        def provider(_id):
            nonlocal count
            with lock:count+=1
            time.sleep(.1);return {'asset_keys':[],'provider_id':'mock-request','usage':{'verified_usd':.2}}
        def caller(_):
            db=DB()
            try:return Ledger(SimpleNamespace(db=db,job=self.job)).execute('same','elevenlabs','eleven_v4','narration',{'text':'ฝัน'},.4,provider)
            except AmbiguousCall:return 'blocked duplicate'
            finally:db.conn.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:list(ex.map(caller,range(5)))
        self.assertEqual(count,1)
        self.assertEqual(self.db.one('SELECT count(*) AS n FROM creative_calls WHERE job_id=%s',(self.job['id'],))['n'],1)
    def test_reservations_compete_for_job_budget_atomically(self):
        def caller(i):
            db=DB()
            try:Ledger(SimpleNamespace(db=db,job=self.job)).reserve(str(i),'elevenlabs','eleven_v4','narration',{'part':i},.6);return 'reserved'
            except RuntimeError:return 'blocked'
            finally:db.conn.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:result=list(ex.map(caller,range(2)))
        self.assertCountEqual(result,['reserved','blocked'])
    def test_timeout_retains_money_and_never_reposts(self):
        ledger=Ledger(self.ctx);count=0
        def provider(_):
            nonlocal count
            count+=1;raise TimeoutError('network response lost')
        with self.assertRaises(TimeoutError):ledger.execute('lost','elevenlabs','eleven_v4','narration',{},.8,provider)
        with self.assertRaises(AmbiguousCall):ledger.execute('lost','elevenlabs','eleven_v4','narration',{},.8,provider)
        with self.assertRaises(RuntimeError):ledger.reserve('other','elevenlabs','eleven_v4','narration',{},.3)
        self.assertEqual(count,1)
    def test_cancelled_jobs_and_changed_payloads_cannot_spend(self):
        ledger=Ledger(self.ctx);ledger.reserve('key','elevenlabs','eleven_v4','narration',{'a':1},.2)
        with self.assertRaises(RuntimeError):ledger.reserve('key','elevenlabs','eleven_v4','narration',{'a':2},.2)
        self.db.q("UPDATE jobs SET status='CANCELLED' WHERE id=%s",(self.job['id'],))
        with self.assertRaises(RuntimeError):ledger.reserve('new','elevenlabs','eleven_v4','narration',{},.2)
    def test_approved_classic_render_is_reserved_and_replayed_without_rendering_twice(self):
        from motion_worker import pipeline
        self.db.q('UPDATE creative_approvals SET allocations=%s::jsonb WHERE job_id=%s',(json.dumps({'compute':1}),self.job['id']))
        ctx=SimpleNamespace(db=self.db,job=self.job,pkg={'scene_code':'fixture scene','creative':{'allocations':{'compute':.6}}},r={'BUILDING_TIMELINE':{'timeline_key':'fixture'}})
        with patch.object(pipeline,'_stage_render',return_value={'final_key':'final','silent_key':'silent'}) as render:
            self.assertEqual(pipeline.stage_render(ctx)['final_key'],'final');self.assertEqual(pipeline.stage_render(ctx)['final_key'],'final');self.assertEqual(render.call_count,1)
    def test_approved_audio_checkpoint_reuses_each_chunk_and_sfx(self):
        from motion_worker import pipeline,creative_audio,eleven
        from motion_worker.storage import LocalStorage
        allocation={'narration':.7,'sfx':.2,'compute':.1}
        self.db.q('UPDATE creative_approvals SET allocations=%s::jsonb WHERE job_id=%s',(json.dumps(allocation),self.job['id']))
        tone=subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=220:duration=0.6','-f','mp3','-'])
        pkg={'script':[{'id':'s1','text':'แมวพูดได้'},{'id':'s2','text':'เรื่องสมมติ'}],'voice':{'voice_id':'mock-voice','model_id':'eleven_v4'},'sfx':[{'id':'tap','prompt':'fixture-'+str(uuid.uuid4()),'duration':.5,'model_id':'eleven_text_to_sound_v3'}],'music':None,'creative':{'allocations':allocation}}
        # Voice ID is unique to this test run so a previous test database cache cannot mask dispatches.
        pkg['voice']['voice_id']='mock-'+str(uuid.uuid4())
        self.job['package']=pkg;self.db.q('UPDATE jobs SET package=%s::jsonb WHERE id=%s',(json.dumps(pkg),self.job['id']))
        def voice(text,*args,**kwargs):return tone,{'characters':list(text),'character_start_times_seconds':[i*.4/len(text) for i in range(len(text))],'character_end_times_seconds':[(i+1)*.4/len(text) for i in range(len(text))]},{'model_id':'eleven_v4','mock':True}
        with tempfile.TemporaryDirectory() as folder,patch.object(config,'WORKDIR',folder+'/work'),patch.object(eleven,'tts_with_timestamps',side_effect=voice) as tts,patch.object(eleven,'sound_effect',return_value=(tone,{'model_id':'eleven_text_to_sound_v3','mock':True})) as sfx:
            ctx=pipeline.Ctx(self.db,LocalStorage(folder+'/store'),self.job)
            first=creative_audio.stage_audio(ctx);second=creative_audio.stage_audio(ctx)
            self.assertEqual(first['narration_key'],second['narration_key']);self.assertEqual(tts.call_count,2);self.assertEqual(sfx.call_count,1)
            self.assertTrue(all(x['cache_hit'] for x in second['narration_manifest']));self.assertTrue(second['sfx_manifest'][0]['cache_hit'])


if __name__=='__main__':unittest.main()
