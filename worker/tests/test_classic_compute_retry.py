"""Real isolated PostgreSQL checks for Classic local-render recovery.

No provider or production calls: voice/SFX are mocked and all assets are local.
Run with CLASSIC_TEST_DATABASE_URL pointed at a database named lemo_test.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'worker'))
from motion_worker import config, pipeline, eleven
from motion_worker.db import DB
from motion_worker.creative_ledger import Ledger, AmbiguousCall
from motion_worker.storage import LocalStorage


@unittest.skipUnless(os.environ.get('CLASSIC_TEST_DATABASE_URL'), 'isolated PostgreSQL test database required')
class ClassicComputeRetryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        config.DATABASE_URL = os.environ['CLASSIC_TEST_DATABASE_URL']
        with psycopg.connect(config.DATABASE_URL, autocommit=True) as c:
            if c.execute('SELECT current_database()').fetchone()[0] != 'lemo_test':
                raise RuntimeError('Refusing a non-test database')
            for path in sorted((ROOT / 'api/migrations').glob('*.sql')):
                if not c.execute("SELECT to_regclass('schema_migrations')").fetchone()[0] or not c.execute('SELECT 1 FROM schema_migrations WHERE name=%s', (path.name,)).fetchone():
                    c.execute(path.read_text())
                    c.execute('INSERT INTO schema_migrations(name) VALUES(%s)', (path.name,))

    def setUp(self):
        self.db = DB()
        self.pkg = {'creative': {'engine': 'classic', 'allocations': {'narration': .7, 'sfx': .2, 'compute': .1}}, 'scene_code': 'fixture scene'}
        draft = self.db.one("INSERT INTO drafts(topic) VALUES('isolated Classic compute test') RETURNING id")
        self.job = self.db.one("INSERT INTO jobs(kind,status,package) VALUES('episode','NEW',%s::jsonb) RETURNING *", (json.dumps(self.pkg),))
        self.db.q("INSERT INTO creative_approvals(draft_id,revision,quote,allocations,max_usd,unknown_ack,job_id) VALUES(%s,%s,'{}',%s::jsonb,1,true,%s)", (draft['id'], str(uuid.uuid4()), json.dumps(self.pkg['creative']['allocations']), self.job['id']))
        self.ctx = SimpleNamespace(db=self.db, job=self.job)

    def tearDown(self):
        self.db.conn.close()

    def fail_render(self):
        def fail(_):
            raise OSError('temporary local encoder failure')
        with self.assertRaises(OSError):
            Ledger(self.ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {'scene': 'fixture'}, .1, fail)

    def test_full_stage_resume_reuses_audio_and_existing_compute_reservation(self):
        tone = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.6', '-f', 'mp3', '-'])
        self.pkg.update({'script': [{'id': 'intro', 'text': 'ฝัน'}], 'voice': {'voice_id': 'fixture-' + str(uuid.uuid4()), 'model_id': 'eleven_v4'}, 'sfx': [{'id': 'tap', 'prompt': 'fixture-' + str(uuid.uuid4()), 'duration': .5, 'model_id': 'eleven_text_to_sound_v3'}], 'music': None})
        self.db.q('UPDATE jobs SET package=%s::jsonb WHERE id=%s', (json.dumps(self.pkg), self.job['id']))
        self.job['package'] = self.pkg
        def voice(text, *args, **kwargs):
            return tone, {'characters': list(text), 'character_start_times_seconds': [i * .4 / len(text) for i in range(len(text))], 'character_end_times_seconds': [(i + 1) * .4 / len(text) for i in range(len(text))]}, {'mock': True}
        stages = {**pipeline.STAGES, 'BUILDING_TIMELINE': lambda _: {'timeline_key': 'saved-fixture'}, 'QUALITY_CHECK': lambda _: {'ok': True}, 'UPLOADING_DRIVE': lambda _: {'episode_number': 1, 'folder_url': 'local-fixture', 'storage': 'r2'}}
        with tempfile.TemporaryDirectory() as folder, patch.object(config, 'WORKDIR', folder + '/work'), patch.object(pipeline, 'STAGES', stages), patch.object(eleven, 'tts_with_timestamps', side_effect=voice) as tts, patch.object(eleven, 'sound_effect', return_value=(tone, {'mock': True})) as sfx, patch.object(pipeline, '_stage_render', side_effect=[OSError('temporary encoder failure'), {'final_key': 'saved-final', 'silent_key': 'saved-silent'}]) as render:
            store = LocalStorage(folder + '/store')
            with self.assertRaises(OSError):
                pipeline.run_episode(pipeline.Ctx(self.db, store, self.job), 'fixture-worker')
            before = self.db.one("SELECT * FROM creative_calls WHERE job_id=%s AND category='compute'", (self.job['id'],))
            self.assertEqual(before['status'], 'reserved')
            self.db.fail(self.job, 'fixture failed', final=True)
            self.db.q("UPDATE jobs SET status='NEW',error=NULL WHERE id=%s", (self.job['id'],))
            resumed = self.db.one('SELECT * FROM jobs WHERE id=%s', (self.job['id'],))
            result = pipeline.run_episode(pipeline.Ctx(self.db, store, resumed), 'fixture-worker')
            self.assertEqual(result['episode_number'], 1)
            self.assertEqual(tts.call_count, 1)
            self.assertEqual(sfx.call_count, 1)
            self.assertEqual(render.call_count, 2)
            after = self.db.one("SELECT * FROM creative_calls WHERE job_id=%s AND category='compute'", (self.job['id'],))
            self.assertEqual(before['id'], after['id'])
            self.assertEqual(after['status'], 'complete')
            self.assertEqual(float(after['reserved_usd']), .1)
            self.assertEqual(self.db.one('SELECT count(*) AS n FROM creative_calls WHERE job_id=%s', (self.job['id'],))['n'], 3)

    def test_reclaimed_reservation_cannot_render_concurrently(self):
        self.fail_render()
        count = 0
        lock = threading.Lock()
        def render(_):
            nonlocal count
            with lock:
                count += 1
            time.sleep(.15)
            return {'asset_keys': []}
        def caller(_):
            db = DB()
            try:
                return Ledger(SimpleNamespace(db=db, job=self.job)).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {'scene': 'fixture'}, .1, render)
            except AmbiguousCall:
                return 'blocked'
            finally:
                db.conn.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
            list(ex.map(caller, range(5)))
        self.assertEqual(count, 1)
        self.assertEqual(self.db.one('SELECT count(*) AS n FROM creative_calls WHERE job_id=%s', (self.job['id'],))['n'], 1)

    def test_cancelled_or_changed_local_work_cannot_resume(self):
        self.fail_render()
        render = unittest.mock.Mock(return_value={})
        with self.assertRaisesRegex(RuntimeError, 'Idempotency'):
            Ledger(self.ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {'scene': 'changed'}, .1, render)
        self.db.q("UPDATE jobs SET status='CANCELLED' WHERE id=%s", (self.job['id'],))
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            Ledger(self.ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {'scene': 'fixture'}, .1, render)
        render.assert_not_called()

    def test_historical_uncertain_local_render_needs_explicit_retry_reset(self):
        self.fail_render()
        self.db.q("UPDATE creative_calls SET status='uncertain' WHERE job_id=%s", (self.job['id'],))
        render = unittest.mock.Mock(return_value={'asset_keys': []})
        with self.assertRaises(AmbiguousCall):
            Ledger(self.ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {'scene': 'fixture'}, .1, render)
        render.assert_not_called()
        self.db.q("UPDATE creative_calls SET status='reserved' WHERE job_id=%s", (self.job['id'],))
        Ledger(self.ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {'scene': 'fixture'}, .1, render)
        self.assertEqual(render.call_count, 1)

    def test_external_uncertainty_and_wrong_compute_identity_remain_blocked(self):
        self.db.q('UPDATE creative_approvals SET allocations=%s::jsonb WHERE job_id=%s', (json.dumps({'narration': 1, 'compute': 1, 'coding': 1}), self.job['id']))
        cases = [('voice', 'elevenlabs', 'eleven_v4', 'narration'), ('executor', 'executor', 'canvas2d', 'compute'), ('video', 'fal', 'video-model', 'compute'), ('coding', 'openai', 'gpt-6.1-sol', 'coding'), ('wrong-key', 'infrastructure', 'classic', 'compute'), ('classic-render-v1', 'infrastructure', 'other', 'compute')]
        for key, provider, model, category in cases:
            with self.subTest(key=key):
                call = unittest.mock.Mock(side_effect=TimeoutError('lost response'))
                with self.assertRaises(TimeoutError):
                    Ledger(self.ctx).execute(key, provider, model, category, {}, .1, call)
                self.assertEqual(self.db.one('SELECT status FROM creative_calls WHERE job_id=%s AND call_key=%s', (self.job['id'], key))['status'], 'uncertain')
                with self.assertRaises(AmbiguousCall):
                    Ledger(self.ctx).execute(key, provider, model, category, {}, .1, call)
                self.assertEqual(call.call_count, 1)

    def test_lemo_job_cannot_use_local_classic_retry_exception(self):
        self.job['kind'] = 'lemo'
        self.job['package']['creative']['engine'] = 'lemo'
        self.db.q("UPDATE jobs SET kind='lemo',package=%s::jsonb WHERE id=%s", (json.dumps(self.job['package']), self.job['id']))
        call = unittest.mock.Mock(side_effect=OSError('executor outcome unknown'))
        with self.assertRaises(OSError):
            Ledger(self.ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {}, .1, call)
        self.assertEqual(self.db.one('SELECT status FROM creative_calls WHERE job_id=%s', (self.job['id'],))['status'], 'uncertain')
        with self.assertRaises(AmbiguousCall):
            Ledger(self.ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute', {}, .1, call)
        self.assertEqual(call.call_count, 1)


if __name__ == '__main__':
    unittest.main()
