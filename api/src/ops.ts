// Operations: failure alerts (optional webhook) and storage retention for intermediates (dry-run unless explicitly enabled).
import type pg from 'pg';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const env = process.env;

async function post(url: string, text: string) {
  // Slack uses "text", Discord uses "content": send both so either kind of incoming webhook works.
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`webhook HTTP ${r.status}`);
}

export async function alertSweep(pool: pg.Pool) {
  const url = env.MOTION_ALERT_WEBHOOK_URL;
  if (!url) return { enabled: false, sent: 0 };
  const rows = (await pool.query(`
    SELECT j.id, j.status, j.error, COALESCE(e.title_th, j.package->>'title_th') AS title, j.updated_at,
           CASE WHEN j.status = 'FAILED' THEN 'failed' ELSE 'stuck' END AS why
    FROM jobs j LEFT JOIN episodes e ON e.id = j.episode_id
    WHERE j.kind = 'episode' AND (
          j.status = 'FAILED'
       OR (j.status NOT IN ('READY_TO_POST','CANCELLED','NEW') AND j.updated_at < now() - interval '45 minutes' AND (j.locked_until IS NULL OR j.locked_until < now())))
      AND j.updated_at > now() - interval '3 days'
      AND NOT EXISTS (SELECT 1 FROM ops_log o WHERE o.kind = 'alert' AND o.data->>'job_id' = j.id::text AND o.data->>'why' = (CASE WHEN j.status = 'FAILED' THEN 'failed' ELSE 'stuck' END))`)).rows;
  let sent = 0;
  for (const r of rows) {
    const msg = `Motion Studio: job ${r.why} — ${r.title || r.id} (${r.status})${r.error ? `\n${String(r.error).slice(0, 300)}` : ''}\nวิธีแก้: เปิดหน้า UI แท็บ “กำลังทำ” แล้วกด “ลองใหม่”`;
    try {
      await post(url, msg);
      await pool.query("INSERT INTO ops_log (kind, message, data) VALUES ('alert', $1, $2)", [msg.slice(0, 500), JSON.stringify({ job_id: r.id, why: r.why })]);
      sent++;
    } catch (e) {
      console.error('alert webhook failed', e instanceof Error ? e.message : e); // will be retried on the next sweep
      break;
    }
  }
  return { enabled: true, sent };
}

// Deletes only re-creatable intermediates (silent video, mix, pre-QA/QA video copies) of delivered jobs older than MOTION_RETENTION_DAYS.
// Never touches: Cloudflare R2 deliverables, the bucket's 'deliverable' copies, TTS/SFX/music (they back the audio cache), anything of unfinished jobs.
// Without MOTION_RETENTION_APPLY=true it only reports what it would delete.
export async function retention(pool: pg.Pool, s3: S3Client | null, apply: boolean) {
  const days = Number(env.MOTION_RETENTION_DAYS || 0);
  if (!days || days < 3) return { enabled: false, note: 'set MOTION_RETENTION_DAYS (>=3) to enable' };
  if (!s3 || !env.BUCKET) return { enabled: false, note: 'no bucket configured' };
  const rows = (await pool.query(`
    SELECT a.id, a.storage_key, COALESCE(a.bytes, 0)::bigint AS bytes
    FROM assets a JOIN jobs j ON j.id = a.job_id
    WHERE j.status = 'READY_TO_POST' AND j.finished_at < now() - ($1 || ' days')::interval
      AND a.kind IN ('video_silent', 'mix', 'video')
      AND COALESCE((a.meta->>'deleted')::boolean, false) = false
      AND a.storage_key NOT IN (SELECT storage_key FROM audio_cache)
      AND a.storage_key NOT LIKE '%/deliver/%'
    ORDER BY a.id LIMIT 500`, [String(days)])).rows;
  const bytes = rows.reduce((n, r) => n + Number(r.bytes), 0);
  if (!apply) return { enabled: true, applied: false, would_delete: rows.length, bytes };
  let deleted = 0;
  for (const r of rows) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: env.BUCKET!, Key: r.storage_key }));
      await pool.query("UPDATE assets SET meta = COALESCE(meta, '{}'::jsonb) || '{\"deleted\": true}'::jsonb WHERE id = $1", [r.id]);
      deleted++;
    } catch (e) {
      console.error('retention delete failed', r.storage_key, e instanceof Error ? e.message : e);
    }
  }
  await pool.query("INSERT INTO ops_log (kind, message, data) VALUES ('retention', $1, $2)", [`deleted ${deleted} intermediate objects`, JSON.stringify({ deleted, bytes })]);
  return { enabled: true, applied: true, deleted, bytes };
}
