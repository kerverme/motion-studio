import concurrent.futures, json, os, sys, threading, time, unittest, uuid
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


if __name__=='__main__':unittest.main()
