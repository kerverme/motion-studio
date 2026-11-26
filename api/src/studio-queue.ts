import type pg from 'pg';
import {IS_STUDIO_DRAFT} from './studio-draft-queries.js';
import {OpenAIReadUnavailable} from './openai-response.js';

export type PlannerDb = Pick<pg.Pool, 'query'>;
export type PlannerSession = (work: (db: PlannerDb) => Promise<void>) => Promise<void>;

// Spans provider waits without an open transaction. Postgres releases this lock on
// process death; all planner receipts and writes use this same physical connection.
export async function withStudioPlannerSession(pool: pg.Pool, work: (db: PlannerDb) => Promise<void>) {
  const client = await pool.connect();
  let locked = false, lost = false;
  const onError = () => { lost = true; };
  client.on('error', onError);
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(731126) AS locked')).rows[0].locked;
    if (locked) await work(client);
  } finally {
    if (locked && !lost) {
      try { await client.query('SELECT pg_advisory_unlock(731126)'); } catch { lost = true; }
    }
    client.removeListener('error', onError);
    client.release(lost);
  }
}

export async function drainStudioQueue(db: PlannerDb, generate: (id: string, db: PlannerDb) => Promise<void>) {
  // During rollout a previous release can still own an unjournaled draft. Its
  // background polling emits progress at least once per minute (15-minute deadline).
  await db.query(`UPDATE drafts SET status='failed', error='ระบบรีสตาร์ทระหว่างเขียน ยังไม่มีจุดบันทึกรอบที่ยืนยันคำขอเดิมได้', updated_at=now()
    WHERE status IN ('researching','writing') AND planner_checkpoint IS NULL AND updated_at < now()-interval '30 minutes'
      AND removed_at IS NULL AND ${IS_STUDIO_DRAFT}`);
  const deferred: string[] = [];
  for (;;) {
    const interrupted = (await db.query(
      `SELECT id FROM drafts WHERE status IN ('researching','writing') AND planner_checkpoint IS NOT NULL AND removed_at IS NULL
         AND ${IS_STUDIO_DRAFT} AND id<>ALL($1::uuid[]) ORDER BY created_at,id LIMIT 1`, [deferred])).rows[0];
    const next = interrupted || (await db.query(`SELECT id FROM drafts WHERE status='queued' AND removed_at IS NULL AND ${IS_STUDIO_DRAFT}
      AND id<>ALL($1::uuid[]) ORDER BY created_at,id LIMIT 1`, [deferred])).rows[0];
    if (!next) return;
    try {
      await generate(next.id, db);
    } catch (e) {
      if (e instanceof OpenAIReadUnavailable) {
        // Keep the accepted response attached; another draft may proceed on this tick.
        deferred.push(next.id);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const written = await db.query("UPDATE drafts SET status='failed', error=$2, log=log || $3::jsonb, updated_at=now() WHERE id=$1 AND removed_at IS NULL AND status IN ('queued','researching','writing')",
        [next.id, msg.slice(0,500), JSON.stringify([{at:new Date().toISOString(),msg:`ล้มเหลว: ${msg.slice(0,160)}`}])]);
      if (written.rowCount) console.error('studio', next.id, msg);
    }
  }
}
