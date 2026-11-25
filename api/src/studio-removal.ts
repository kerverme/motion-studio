import type pg from 'pg';
import {z} from 'zod';
import {IS_STUDIO_DRAFT} from './studio-draft-queries.js';

const ids = z.array(z.string().uuid().transform(id => id.toLowerCase())).max(100);
export const removalRequest = z.object({draft_ids: ids, job_ids: ids, confirm: z.literal(true)})
  .refine(x => x.draft_ids.length + x.job_ids.length > 0 && x.draft_ids.length + x.job_ids.length <= 100);

export async function removeStudioItems(pool: pg.Pool, input: z.infer<typeof removalRequest>) {
  const drafts = [...new Set(input.draft_ids)], jobs = [...new Set(input.job_ids)];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT id, job_id FROM drafts WHERE id=ANY($1::uuid[]) AND ${IS_STUDIO_DRAFT} ORDER BY id FOR UPDATE`, [drafts]);
    const linked = selected.rows.flatMap(row => row.job_id ? [row.job_id] : []);
    const targets = await client.query(
      `SELECT id, status FROM jobs WHERE kind IN ('episode','lemo','text_video') AND
         (id=ANY($1::uuid[]) OR idempotency_key=ANY($2::text[])) ORDER BY id FOR UPDATE`,
      [[...jobs, ...linked], drafts.map(id => 'draft:'+id)]);
    if (selected.rows.length !== drafts.length || jobs.some(id => !targets.rows.some(j => j.id === id))) {
      await client.query('ROLLBACK');
      return {ok:false, error:'ไม่พบรายการที่เลือก กรุณาโหลดรายการใหม่'} as const;
    }
    if (targets.rows.some(j => j.status === 'READY_TO_POST' && jobs.includes(j.id))) {
      await client.query('ROLLBACK');
      return {ok:false, error:'งานที่เลือกผลิตเสร็จแล้ว กรุณาตรวจรายการอีกครั้ง'} as const;
    }
    await client.query("UPDATE drafts SET status='discarded', removed_at=now(), updated_at=now() WHERE id=ANY($1::uuid[]) AND removed_at IS NULL", [drafts]);
    const cancelled = await client.query(
      `UPDATE jobs SET status='CANCELLED', removed_at=now(), finished_at=COALESCE(finished_at,now()), updated_at=now()
       WHERE id=ANY($1::uuid[]) AND status<>'READY_TO_POST' AND removed_at IS NULL RETURNING id`,
      [targets.rows.map(j=>j.id)]);
    await client.query("INSERT INTO job_events(job_id,status,message) SELECT id,'CANCELLED','Removed from Studio by owner' FROM unnest($1::uuid[]) AS t(id)", [cancelled.rows.map(j => j.id)]);
    await client.query('COMMIT');
    return {ok:true} as const;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
