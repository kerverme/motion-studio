// Keeps one row per episode in the Notion database "Motion Studio Episodes" in step with Postgres:
// title, video URL, Used checkbox, platforms, publish time, post links and headline metrics.
// Needs NOTION_TOKEN (an internal integration connected to that database). Without it nothing is written.
import type pg from 'pg';

const env = process.env;
const DB_ID = env.NOTION_DATABASE_ID || 'dc014fe11c8b457ab2ca0a6f6c9f99a7';
const API = env.NOTION_API_URL || 'https://api.notion.com';
const LABEL: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', twitter: 'X' };

export const configured = () => !!env.NOTION_TOKEN;

async function call(path: string, method: string, body?: unknown, tries = 3): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      const wait = Number(r.headers.get('retry-after') || 0) * 1000 || 1500 * (i + 1);
      await new Promise((res) => setTimeout(res, Math.min(wait, 20_000)));
      continue;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Notion ${r.status}: ${j.code || ''} ${String(j.message || '').slice(0, 200)}`);
    return j;
  }
}

const text = (s: string | null | undefined) => ({ rich_text: s ? [{ type: 'text', text: { content: String(s).slice(0, 1990) } }] : [] });
const num = (n: number | null | undefined) => ({ number: n == null || Number.isNaN(n) ? null : n });
const date = (d: Date | string | null | undefined) => ({ date: d ? { start: new Date(d).toISOString() } : null });

async function properties(pool: pg.Pool, id: string) {
  const e = (await pool.query(`
    SELECT e.*, h.files, h.created_at AS delivered_at, h.folder_id, j.id AS job_id, j.used_credits, j.package->'voice'->>'voice_id' AS voice_id,
           j.package->>'series_tag' AS series_tag
    FROM episodes e
    LEFT JOIN LATERAL (SELECT * FROM publication_handoffs WHERE episode_id = e.id ORDER BY id DESC LIMIT 1) h ON true
    LEFT JOIN jobs j ON j.id = h.job_id
    WHERE e.id = $1`, [id])).rows[0];
  if (!e) return null;
  const posts = (await pool.query("SELECT * FROM publish_log WHERE episode_id=$1 AND status='sent' ORDER BY id", [id])).rows;
  const files: any[] = Array.isArray(e.files) ? e.files : [];
  const video = files.find((f) => String(f.name).endsWith('.mp4'));
  const withM = posts.filter((p) => p.metrics);
  const total = (k: string) => (withM.length ? withM.reduce((n, p) => n + (Number(p.metrics[k]) || 0), 0) : null);
  const firstSent = posts.map((p) => p.sent_at || p.created_at).filter(Boolean).sort()[0] ?? null;
  const lastMetrics = posts.map((p) => p.metrics_updated_at).filter(Boolean).sort().pop() ?? null;
  const links = posts.map((p) => `${LABEL[p.service] || p.service}: ${p.external_link || (p.post_status === 'sent' ? 'published' : `in Buffer (${p.post_status || p.mode})`)}`).join('\n');
  const used = e.ui_status === 'used';
  const props: Record<string, unknown> = {
    Title: { title: [{ type: 'text', text: { content: String(e.title_th).slice(0, 1990) } }] },
    Episode: num(e.number),
    Topic: text(e.topic),
    Series: text(e.series_tag),
    Status: { select: { name: posts.some((p) => p.post_status === 'sent') ? 'Posted' : 'Ready to post' } },
    Used: { checkbox: used },
    'Video URL': { url: video?.url ?? null },
    'Created At': date(e.delivered_at || e.created_at),
    'File Size (MB)': num(video?.bytes ? Math.round((video.bytes / 1048576) * 10) / 10 : null),
    'Job ID': text(e.job_id),
    'Storage Key': text(e.folder_id),
    Resolution: text('1080x1920 30fps'),
    'Voice ID': text(e.voice_id),
    'ElevenLabs Credits': num(e.used_credits != null ? Number(e.used_credits) : null),
    Platforms: { multi_select: [...new Set(posts.map((p) => LABEL[p.service]).filter(Boolean))].map((name) => ({ name })) },
    'Published At': date(firstSent),
    'Post Links': text(links),
    Views: num(total('views')),
    Reactions: num(total('reactions')),
    Comments: num(total('comments')),
    Shares: num(total('shares')),
    'Metrics Updated': date(lastMetrics),
  };
  // never blank out production facts that were filled in by hand when this sync has nothing better
  for (const k of ['Topic', 'Series', 'Job ID', 'Storage Key', 'Voice ID', 'ElevenLabs Credits', 'File Size (MB)', 'Video URL', 'Episode']) {
    const v: any = props[k];
    if (!v || (v.rich_text && !v.rich_text.length) || v.number === null || v.url === null || (k === 'ElevenLabs Credits' && v.number === 0)) delete props[k];
  }
  return { e, props };
}

export async function syncEpisode(pool: pg.Pool, id: string) {
  if (!configured()) return { ok: false, skipped: 'NOTION_TOKEN not set' };
  try {
    const p = await properties(pool, id);
    if (!p) return { ok: false, error: 'episode not found' };
    let pageId: string | null = p.e.notion_page_id;
    if (!pageId && p.e.number != null) {
      const q = await call(`/v1/databases/${DB_ID}/query`, 'POST', { filter: { property: 'Episode', number: { equals: p.e.number } }, page_size: 1 });
      pageId = q.results?.[0]?.id ?? null;
    }
    if (pageId) {
      try {
        await call(`/v1/pages/${pageId}`, 'PATCH', { properties: p.props });
      } catch (err) {
        if (!/404|object_not_found|archived/i.test(String(err))) throw err;
        pageId = null; // row was deleted in Notion: create a new one
      }
    }
    if (!pageId) {
      const created = await call('/v1/pages', 'POST', { parent: { database_id: DB_ID }, icon: { type: 'emoji', emoji: '🎬' }, properties: p.props });
      pageId = created.id;
    }
    await pool.query('UPDATE episodes SET notion_page_id=$2, notion_synced_at=now(), notion_error=NULL WHERE id=$1', [id, pageId]);
    return { ok: true, page_id: pageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query('UPDATE episodes SET notion_error=$2 WHERE id=$1', [id, msg.slice(0, 500)]).catch(() => {});
    console.error('notion sync', id, msg);
    return { ok: false, error: msg };
  }
}

// queue so event-driven syncs never run in parallel (Notion allows ~3 requests/s)
let chain: Promise<unknown> = Promise.resolve();
export function syncLater(pool: pg.Pool, ids: string[]) {
  if (!configured()) return;
  for (const id of new Set(ids)) chain = chain.then(() => syncEpisode(pool, id)).catch(() => {});
}

export async function syncAll(pool: pg.Pool) {
  if (!configured()) return { ok: false, skipped: 'NOTION_TOKEN not set' };
  const ids = (await pool.query('SELECT DISTINCT episode_id FROM publication_handoffs')).rows.map((r) => r.episode_id);
  let ok = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const r = await syncEpisode(pool, id);
    if (r.ok) ok++; else if (r.error) errors.push(r.error);
    await new Promise((res) => setTimeout(res, 400));
  }
  return { ok: errors.length === 0, synced: ok, total: ids.length, errors: errors.slice(0, 3) };
}
