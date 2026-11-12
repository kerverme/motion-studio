import json, threading, time
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from . import config

TERMINAL = ('READY_TO_POST', 'FAILED', 'CANCELLED')


def connect():
    return psycopg.connect(config.DATABASE_URL, row_factory=dict_row, autocommit=True)


class DB:
    def __init__(self):
        self.conn = connect()
        self.lock = threading.Lock()

    def q(self, sql, args=None):
        with self.lock:
            try:
                cur = self.conn.execute(sql, args or ())
            except psycopg.OperationalError:
                self.conn = connect()
                cur = self.conn.execute(sql, args or ())
            try:
                return cur.fetchall()
            except psycopg.ProgrammingError:
                return []

    def one(self, sql, args=None):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    # ---------------------------------------------------------------- jobs
    def claim(self, worker):
        return self.one(
            """UPDATE jobs SET locked_by=%s, locked_until=now() + interval '10 minutes', attempts=attempts+1, updated_at=now()
               WHERE id = (SELECT id FROM jobs WHERE status NOT IN ('READY_TO_POST','FAILED','CANCELLED')
                           AND (locked_until IS NULL OR locked_until < now())
                           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
               RETURNING *""", (worker,))

    def heartbeat(self, job_id, worker):
        self.q("UPDATE jobs SET locked_until=now() + interval '10 minutes' WHERE id=%s AND locked_by=%s", (job_id, worker))

    def status(self, job, status, stage=None, progress=None, message=None, data=None, level='info'):
        updated = self.q("""UPDATE jobs SET status=%s, stage=COALESCE(%s, stage), progress=COALESCE(%s, progress), updated_at=now(),
                  finished_at=CASE WHEN %s IN ('READY_TO_POST','FAILED') THEN now() ELSE finished_at END WHERE id=%s
                  AND (kind<>'text_video' OR status<>'CANCELLED') RETURNING id""",
               (status, stage, progress, status, job['id']))
        if job.get('kind') == 'text_video' and not updated:
            from .text_video import JobCancelled
            raise JobCancelled('Text to Video was cancelled')
        if job.get('episode_id'):
            self.q('UPDATE episodes SET status=%s, updated_at=now() WHERE id=%s', (status, job['episode_id']))
        if message:
            self.event(job['id'], message, data, level, status)
        job['status'] = status

    def event(self, job_id, message, data=None, level='info', status=None):
        self.q('INSERT INTO job_events (job_id, status, level, message, data) VALUES (%s,%s,%s,%s,%s)',
               (job_id, status, level, message, Jsonb(data) if data is not None else None))

    def save_stage(self, job, stage, result):
        job['stage_results'][stage] = result
        self.q("UPDATE jobs SET stage_results = stage_results || %s::jsonb, updated_at=now() WHERE id=%s",
               (json.dumps({stage: result}), job['id']))

    def add_credits(self, job, credits):
        if credits:
            self.q('UPDATE jobs SET used_credits = used_credits + %s WHERE id=%s', (credits, job['id']))
            job['used_credits'] = float(job.get('used_credits') or 0) + float(credits)

    def asset(self, job, kind, key, nbytes=None, sha=None, meta=None):
        self.q("""INSERT INTO assets (job_id, episode_id, kind, storage_key, bytes, sha256, meta) VALUES (%s,%s,%s,%s,%s,%s,%s)
                  ON CONFLICT (job_id, storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, meta=EXCLUDED.meta""",
               (job['id'], job.get('episode_id'), kind, key, nbytes, sha, Jsonb(meta) if meta is not None else None))

    def attempt_start(self, job, stage, worker):
        r = self.one('INSERT INTO render_attempts (job_id, stage, attempt, status, worker) VALUES (%s,%s,%s,%s,%s) RETURNING id',
                     (job['id'], stage, job['attempts'], 'running', worker))
        return r['id']

    def attempt_end(self, attempt_id, ok, error=None):
        self.q('UPDATE render_attempts SET status=%s, error=%s, finished_at=now() WHERE id=%s',
               ('succeeded' if ok else 'failed', error, attempt_id))

    def fail(self, job, error, final):
        if final:
            updated = self.q("""UPDATE jobs SET status='FAILED', error=%s, locked_by=NULL, locked_until=NULL, updated_at=now(), finished_at=now() WHERE id=%s
                               AND (kind<>'text_video' OR status<>'CANCELLED') RETURNING id""",
                   (error[:4000], job['id']))
            if job.get('kind') == 'text_video' and not updated:
                return
            if job.get('episode_id'):
                self.q("UPDATE episodes SET status='FAILED', updated_at=now() WHERE id=%s", (job['episode_id'],))
            self.event(job['id'], 'job failed: ' + error[:500], None, 'error', 'FAILED')
        else:
            backoff = 60 * job['attempts']
            self.q("UPDATE jobs SET error=%s, locked_by=NULL, locked_until=now() + (%s || ' seconds')::interval, updated_at=now() WHERE id=%s",
                   (error[:4000], str(backoff), job['id']))
            self.event(job['id'], f'stage failed, retrying in {backoff}s: ' + error[:500], None, 'warn', job['status'])

    def release(self, job):
        self.q('UPDATE jobs SET locked_by=NULL, locked_until=NULL, error=NULL WHERE id=%s', (job['id'],))

    # ---------------------------------------------------------------- cache / episodes
    def cache_get(self, key):
        return self.one('SELECT * FROM audio_cache WHERE cache_key=%s', (key,))

    def cache_put(self, key, kind, storage_key, credits, meta):
        self.q("""INSERT INTO audio_cache (cache_key, kind, storage_key, credits, meta) VALUES (%s,%s,%s,%s,%s)
                  ON CONFLICT (cache_key) DO NOTHING""", (key, kind, storage_key, credits, Jsonb(meta)))

    def episode(self, episode_id):
        return self.one('SELECT * FROM episodes WHERE id=%s', (episode_id,))

    def assign_episode_number(self, episode_id):
        ep = self.episode(episode_id)
        if ep['number']:
            return ep['number']
        with self.lock:
            with self.conn.transaction():
                n = self.conn.execute("UPDATE counters SET value=value+1 WHERE name='episode_number' RETURNING value").fetchone()['value']
                self.conn.execute('UPDATE episodes SET number=%s WHERE id=%s AND number IS NULL', (n, episode_id))
        return self.episode(episode_id)['number']


class Heartbeat(threading.Thread):
    def __init__(self, db, job_id, worker):
        super().__init__(daemon=True)
        self.db, self.job_id, self.worker = db, job_id, worker
        self.stop = threading.Event()

    def run(self):
        while not self.stop.wait(60):
            try:
                self.db.heartbeat(self.job_id, self.worker)
            except Exception:
                pass
