// Follows each post sent to Buffer: publishing status, the live link, and per-post analytics (Buffer refreshes metrics about daily).
import type pg from 'pg';
import * as buffer from './buffer.js';

export const KEY_METRICS = ['views', 'reach', 'impressions', 'reactions', 'comments', 'shares', 'saves', 'reposts', 'engagementRate'] as const;

let running = false;
export async function syncPosts(pool: pg.Pool, opts: { limit?: number; force?: boolean } = {}) {
  if (!buffer.configured() || running) return { checked: 0, changed: [] as string[], skipped: true };
  running = true;
  const changed = new Set<string>();
  let checked = 0, failed = 0;
  try {
    const rows = (await pool.query(`
      SELECT id, episode_id, buffer_post_id, post_status, metrics_updated_at FROM publish_log
      WHERE status = 'sent' AND buffer_post_id IS NOT NULL AND (
            $1::boolean
         OR post_status IS NULL OR post_status NOT IN ('sent', 'error')
         OR (post_status = 'sent' AND created_at > now() - interval '90 days' AND (checked_at IS NULL OR checked_at < now() - interval '6 hours')))
      ORDER BY checked_at NULLS FIRST, id LIMIT $2`, [!!opts.force, opts.limit ?? 25])).rows;
    for (const r of rows) {
      try {
        const { post } = await buffer.getPost(r.buffer_post_id);
        checked++;
        if (!post) {
          await pool.query("UPDATE publish_log SET post_status='deleted', checked_at=now() WHERE id=$1", [r.id]);
          changed.add(r.episode_id);
          continue;
        }
        const status = String(post.status || '').toLowerCase();
        const m: Record<string, number> = {};
        for (const x of post.metrics ?? []) m[x.type] = Number(x.value);
        const hasMetrics = Object.keys(m).length > 0;
        await pool.query(`UPDATE publish_log SET post_status=$2, sent_at=COALESCE($3::timestamptz, sent_at), external_link=COALESCE($4, external_link),
            post_error=$5, metrics=COALESCE($6::jsonb, metrics), metrics_updated_at=COALESCE($7::timestamptz, metrics_updated_at), checked_at=now() WHERE id=$1`,
          [r.id, status, post.sentAt ?? null, post.externalLink ?? null, post.error?.message ?? null, hasMetrics ? JSON.stringify(m) : null, post.metricsUpdatedAt ?? null]);
        if (hasMetrics) {
          await pool.query('INSERT INTO metric_snapshots (publish_log_id, metrics_updated_at, metrics) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [r.id, post.metricsUpdatedAt ?? new Date().toISOString(), JSON.stringify(m)]);
        }
        if (status !== r.post_status || hasMetrics) changed.add(r.episode_id);
      } catch (e) {
        failed++;
        await pool.query('UPDATE publish_log SET checked_at=now() WHERE id=$1', [r.id]);
        console.error('post sync', r.buffer_post_id, e instanceof Error ? e.message : e);
        if (e instanceof buffer.BufferError && e.status === 429) break; // rate limited: stop this round
      }
      await new Promise((res) => setTimeout(res, 300));
    }
  } finally {
    running = false;
  }
  return { checked, failed, changed: [...changed], metrics_available: buffer.metricsAvailable() };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export async function analytics(pool: pg.Pool, days = 30) {
  const posts = (await pool.query(`
    SELECT p.id, p.episode_id, p.service, p.channel_name, p.mode, p.status, p.post_status, p.external_link, p.sent_at, p.due_at, p.created_at,
           p.post_error, p.error, p.metrics, p.metrics_updated_at, e.number, e.title_th
    FROM publish_log p JOIN episodes e ON e.id = p.episode_id
    WHERE p.status IN ('sent', 'pending', 'failed') ORDER BY p.id DESC`)).rows;

  const live = posts.filter((p) => p.status === 'sent');
  const services = ['instagram', 'facebook', 'tiktok', 'twitter'];
  const platforms = services.map((s) => {
    const ps = live.filter((p) => p.service === s);
    const withM = ps.filter((p) => p.metrics);
    const tot: Record<string, number | null> = {};
    for (const k of KEY_METRICS) {
      const vals = withM.map((p) => p.metrics[k]).filter((v: unknown) => typeof v === 'number') as number[];
      tot[k] = vals.length ? (k === 'engagementRate' ? Math.round((sum(vals) / vals.length) * 100) / 100 : sum(vals)) : null;
    }
    return {
      service: s, posts: ps.length,
      published: ps.filter((p) => p.post_status === 'sent').length,
      waiting: ps.filter((p) => p.post_status !== 'sent' && p.post_status !== 'error').length,
      errors: ps.filter((p) => p.post_status === 'error').length
        + posts.filter((p) => p.service === s && p.status === 'failed' && !live.some((l) => l.episode_id === p.episode_id && l.service === s)).length,
      with_metrics: withM.length, totals: tot,
    };
  });

  // daily cumulative views/reactions across all posts, from snapshots (carry the last known value forward)
  const snaps = (await pool.query(`
    SELECT s.publish_log_id, s.metrics, COALESCE(s.metrics_updated_at, s.captured_at) AS at
    FROM metric_snapshots s WHERE COALESCE(s.metrics_updated_at, s.captured_at) > now() - ($1 || ' days')::interval - interval '60 days'
    ORDER BY at`, [String(days)])).rows;
  const series: { date: string; views: number; reactions: number; comments: number }[] = [];
  if (snaps.length) {
    // start at the first day we actually have numbers for: days before that are unknown, not zero
    const windowStart = Date.now() - (days - 1) * 86400_000;
    const firstAt = new Date(snaps[0].at).getTime();
    const start = new Date(Math.max(windowStart, new Date(new Date(firstAt).toISOString().slice(0, 10) + 'T00:00:00Z').getTime()));
    const n = Math.max(1, Math.round((Date.now() - start.getTime()) / 86400_000) + 1);
    for (let i = 0; i < Math.min(n, days); i++) {
      const d = new Date(start.getTime() + i * 86400_000);
      const end = new Date(d.toISOString().slice(0, 10) + 'T23:59:59.999Z').getTime();
      const last = new Map<string, any>();
      for (const s of snaps) if (new Date(s.at).getTime() <= end) last.set(String(s.publish_log_id), s.metrics);
      const vals = [...last.values()];
      series.push({ date: d.toISOString().slice(0, 10), views: sum(vals.map((m) => m.views ?? 0)), reactions: sum(vals.map((m) => m.reactions ?? 0)), comments: sum(vals.map((m) => m.comments ?? 0)) });
    }
  }

  // per clip
  const byEp = new Map<string, any>();
  for (const p of posts) {
    if (!byEp.has(p.episode_id)) byEp.set(p.episode_id, { episode_id: p.episode_id, number: p.number, title: p.title_th, posts: [] });
    byEp.get(p.episode_id).posts.push({
      id: p.id, service: p.service, channel: p.channel_name, status: p.status, post_status: p.post_status, link: p.external_link,
      sent_at: p.sent_at, due_at: p.due_at, created_at: p.created_at, error: p.post_error || p.error, metrics: p.metrics, metrics_updated_at: p.metrics_updated_at,
    });
  }
  const clips = [...byEp.values()].map((c) => {
    const ms = c.posts.filter((p: any) => p.metrics).map((p: any) => p.metrics);
    return { ...c, totals: { views: ms.length ? sum(ms.map((m: any) => m.views ?? 0)) : null, reactions: ms.length ? sum(ms.map((m: any) => m.reactions ?? 0)) : null,
      comments: ms.length ? sum(ms.map((m: any) => m.comments ?? 0)) : null, shares: ms.length ? sum(ms.map((m: any) => m.shares ?? 0)) : null } };
  });

  const last = (await pool.query('SELECT max(checked_at) AS checked, max(metrics_updated_at) AS metrics FROM publish_log')).rows[0];
  return { platforms, series, clips, last_checked_at: last.checked, last_metrics_at: last.metrics, metrics_available: buffer.metricsAvailable(), buffer_configured: buffer.configured() };
}
