// Personal web UI: password login (signed session cookie), clip list with ready/used tabs, publish to Buffer.
import type { Hono, Context, Next } from 'hono';
import type pg from 'pg';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as buffer from './buffer.js';
import * as notion from './notion.js';
import { analytics, syncPosts, reconcile } from './metrics.js';

const env = process.env;
const UI_PASSWORD = env.MOTION_UI_PASSWORD || '';
const SESSION_SECRET = env.MOTION_SESSION_SECRET || createHash('sha256').update(`${env.MOTION_API_TOKEN || ''}|${UI_PASSWORD}|ui`).digest('hex');
const SESSION_DAYS = 7;
const MEDIA_BASE = (env.MOTION_MEDIA_BASE || env.R2_PUBLIC_BASE_URL || 'https://media.cloudbath.co').replace(/\/$/, '');
const MEDIA_ORIGIN = (() => { try { return new URL(MEDIA_BASE).origin; } catch { return 'https://media.cloudbath.co'; } })();
const AI_DISCLOSURE = (env.MOTION_AI_DISCLOSURE || 'true') !== 'false'; // narration is synthetic (ElevenLabs): label it where the platform supports it

function safeEq(a: string, b: string) {
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
const sign = (v: string) => createHmac('sha256', SESSION_SECRET).update(v).digest('hex');

function makeSession() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const nonce = randomBytes(8).toString('hex');
  const body = `${exp}.${nonce}`;
  return `${body}.${sign(body)}`;
}
function validSession(tok: string) {
  const [exp, nonce, sig] = tok.split('.');
  if (!exp || !nonce || !sig) return false;
  if (!safeEq(sig, sign(`${exp}.${nonce}`))) return false;
  return Number(exp) > Math.floor(Date.now() / 1000);
}
function cookie(c: Context, name: string) {
  const h = c.req.header('cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const isHttps = (c: Context) => (c.req.header('x-forwarded-proto') || '').split(',')[0] === 'https' || (env.MOTION_PUBLIC_URL || '').startsWith('https');
const clientIp = (c: Context) => (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'local';

// login throttling (in memory; single replica)
const fails = new Map<string, { n: number; until: number }>();

function titleOf(row: any) {
  return row.title_th as string;
}

export function registerUi(app: Hono, pool: pg.Pool, deps: { API_TOKEN: string; retryJob: (id: string) => Promise<{ ok: boolean; status?: string; error?: string }> }) {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui.html'), 'utf8');

  async function requireUi(c: Context, next: Next) {
    if (!UI_PASSWORD) return c.json({ error: 'ui disabled: MOTION_UI_PASSWORD is not set' }, 503);
    const bearer = (c.req.header('authorization') || '').replace(/^Bearer /, '');
    const okBearer = !!deps.API_TOKEN && !!bearer && safeEq(bearer, deps.API_TOKEN);
    if (!okBearer && !validSession(cookie(c, 'ms'))) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.method !== 'GET' && !okBearer && c.req.header('x-motion-ui') !== '1') return c.json({ error: 'bad request' }, 400); // CSRF guard on top of SameSite=Strict
    await next();
  }

  app.get('/app', (c) => {
    c.header('cache-control', 'no-store');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    c.header('content-security-policy', `default-src 'self'; img-src 'self' ${MEDIA_ORIGIN} data:; media-src ${MEDIA_ORIGIN}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'`);
    return c.html(html);
  });

  app.post('/app/api/login', async (c) => {
    if (!UI_PASSWORD) return c.json({ error: 'ui disabled: MOTION_UI_PASSWORD is not set' }, 503);
    if (c.req.header('x-motion-ui') !== '1') return c.json({ error: 'bad request' }, 400);
    const ip = clientIp(c);
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return c.json({ error: 'too many attempts, try again later' }, 429);
    const body = await c.req.json().catch(() => ({}));
    const pw = typeof body?.password === 'string' ? body.password : '';
    if (!safeEq(pw, UI_PASSWORD)) {
      const n = (f?.n ?? 0) + 1;
      fails.set(ip, n >= 5 ? { n: 0, until: Date.now() + 15 * 60_000 } : { n, until: 0 });
      await new Promise((r) => setTimeout(r, 800));
      return c.json({ error: 'wrong password' }, 401);
    }
    fails.delete(ip);
    const secure = isHttps(c) ? '; Secure' : '';
    c.header('set-cookie', `ms=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return c.json({ ok: true });
  });

  app.post('/app/api/logout', (c) => {
    c.header('set-cookie', `ms=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(c) ? '; Secure' : ''}`);
    return c.json({ ok: true });
  });

  app.get('/app/api/me', async (c) => {
    const authed = !!UI_PASSWORD && validSession(cookie(c, 'ms'));
    return c.json({ authed, ui_enabled: !!UI_PASSWORD });
  });

  // ---- clips
  const CLIP_SQL = `
    SELECT e.id, e.number, e.title_th, e.topic, e.ui_status, e.used_at, e.created_at, e.notion_page_id, e.notion_synced_at, e.notion_error,
           h.files, h.created_at AS delivered_at, j.package->'captions' AS captions, j.package->'thumbnail'->>'mode' AS thumbnail_mode,
           EXTRACT(EPOCH FROM (COALESCE(j.finished_at, h.created_at) - j.created_at))::int AS produce_seconds, j.package->>'series_tag' AS series_tag, j.source_type,
           COALESCE((SELECT json_agg(json_build_object('id', p.id, 'channel_id', p.channel_id, 'channel_name', p.channel_name, 'service', p.service, 'mode', p.mode,
                     'due_at', p.due_at, 'status', p.status, 'error', COALESCE(p.post_error, p.error), 'created_at', p.created_at,
                     'post_status', p.post_status, 'link', p.external_link, 'sent_at', p.sent_at, 'metrics', p.metrics) ORDER BY p.id DESC)
                     FROM publish_log p WHERE p.episode_id = e.id), '[]'::json) AS publications
    FROM episodes e
    JOIN LATERAL (SELECT * FROM publication_handoffs WHERE episode_id = e.id ORDER BY id DESC LIMIT 1) h ON true
    LEFT JOIN jobs j ON j.id = h.job_id`;

  function shape(r: any) {
    const files: any[] = Array.isArray(r.files) ? r.files : [];
    const video = files.find((f) => String(f.name).endsWith('.mp4'));
    const thumb = files.find((f) => String(f.name).endsWith('_thumbnail.png'));
    const caps = (r.captions || {}) as Record<string, string>;
    return {
      id: r.id, number: r.number, title: titleOf(r), topic: r.topic, series_tag: r.series_tag, ui_status: r.ui_status, used_at: r.used_at, delivered_at: r.delivered_at, produce_seconds: r.produce_seconds ?? null, source_type: r.source_type ?? 'studio',
      thumbnail_offset_ms: buffer.thumbnailOffsetFor(r.thumbnail_mode),
      video_url: video?.url ?? null, thumbnail_url: thumb?.url ?? null, video_bytes: video?.bytes ?? null,
      captions: {
        facebook: caps.facebook ?? '', instagram: caps.instagram ?? '', tiktok: caps.tiktok ?? '',
        twitter: caps.twitter ?? caps.tiktok ?? caps.instagram ?? '', youtube: caps.youtube ?? '',
      },
      publications: r.publications,
      notion: { url: r.notion_page_id ? `https://www.notion.so/${String(r.notion_page_id).replace(/-/g, '')}` : null, synced_at: r.notion_synced_at, error: r.notion_error },
    };
  }

  app.get('/app/api/episodes', requireUi, async (c) => {
    const tab = c.req.query('tab') === 'used' ? 'used' : 'ready';
    const r = await pool.query(`${CLIP_SQL} WHERE e.ui_status = $1 ORDER BY e.number DESC NULLS LAST LIMIT 200`, [tab]);
    const cnt = (await pool.query(`SELECT e.ui_status, count(*)::int AS n FROM episodes e WHERE EXISTS (SELECT 1 FROM publication_handoffs h WHERE h.episode_id = e.id) GROUP BY 1`)).rows;
    const working = (await pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind='episode' AND status NOT IN ('READY_TO_POST','CANCELLED')")).rows[0].n;
    const counts = { ready: cnt.find((x) => x.ui_status === 'ready')?.n ?? 0, used: cnt.find((x) => x.ui_status === 'used')?.n ?? 0, working };
    return c.json({ episodes: r.rows.map(shape).filter((e) => e.video_url), counts });
  });

  app.post('/app/api/episodes/:id/used', requireUi, async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const used = body?.used !== false;
    const r = await pool.query('UPDATE episodes SET ui_status=$2, used_at=CASE WHEN $2=\'used\' THEN now() ELSE NULL END WHERE id=$1 RETURNING id', [id, used ? 'used' : 'ready']);
    if (!r.rowCount) return c.json({ error: 'not found' }, 404);
    notion.syncLater(pool, [id]);
    return c.json({ ok: true, ui_status: used ? 'used' : 'ready' });
  });

  // ---- jobs in progress / failed
  app.get('/app/api/working', requireUi, async (c) => {
    const r = await pool.query(`SELECT j.id, j.status, j.stage, j.progress, j.error, j.attempts, j.max_attempts, j.created_at, j.updated_at, j.locked_until,
        COALESCE(e.title_th, j.package->>'title_th') AS title,
        d.id AS draft_id, d.model AS draft_model, d.reasoning AS draft_reasoning,
        COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id, status, level, message, created_at FROM job_events WHERE job_id=j.id ORDER BY id DESC LIMIT 8) x), '[]'::json) AS events,
        (SELECT max(created_at) FROM job_events WHERE job_id=j.id) AS last_event_at
      FROM jobs j LEFT JOIN episodes e ON e.id = j.episode_id LEFT JOIN drafts d ON d.job_id = j.id
      WHERE j.kind='episode' AND j.status NOT IN ('READY_TO_POST','CANCELLED')
         OR (j.kind='episode' AND j.status='CANCELLED' AND j.updated_at > now() - interval '2 days')
      ORDER BY j.created_at DESC LIMIT 30`);
    // drafts an LLM is writing right now (the only place an LLM runs)
    const dr = await pool.query(`SELECT id, topic, status, model, reasoning, log, created_at, updated_at FROM drafts
      WHERE status IN ('queued','researching','writing') ORDER BY created_at DESC LIMIT 5`);
    return c.json({ jobs: r.rows, drafts: dr.rows.map((x: any) => ({ ...x, log: Array.isArray(x.log) ? x.log.slice(-6) : [] })), now: new Date().toISOString() });
  });

  app.post('/app/api/jobs/:id/retry', requireUi, async (c) => {
    const res = await deps.retryJob(c.req.param('id'));
    return c.json(res, res.ok ? 200 : 409);
  });

  // ---- Buffer
  app.get('/app/api/channels', requireUi, async (c) => {
    if (!buffer.configured()) return c.json({ configured: false, channels: [], note: 'BUFFER_API_KEY is not set on motion-api' });
    try {
      const org = await buffer.organization();
      const list = await buffer.channels(c.req.query('refresh') === '1');
      const supported = list.filter((ch) => (buffer.SERVICES as readonly string[]).includes(buffer.normService(ch.service)))
        .map((ch) => ({ id: ch.id, name: ch.displayName || ch.name, service: buffer.normService(ch.service), avatar: ch.avatar ?? null }));
      const missing = buffer.SERVICES.filter((s) => !supported.some((ch) => ch.service === s));
      return c.json({ configured: true, organization: org.name, channels: supported, not_connected: missing });
    } catch (e) {
      return c.json({ configured: true, channels: [], error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  const PublishBody = z.object({
    confirm: z.literal(true),
    mode: z.enum(['shareNow', 'addToQueue', 'customScheduled']),
    dueAt: z.string().optional(),
    posts: z.array(z.object({ channelId: z.string().min(1).max(200), text: z.string().max(2200) })).min(1).max(8),
  });

  app.post('/app/api/episodes/:id/publish', requireUi, async (c) => {
    if (!buffer.configured()) return c.json({ error: 'BUFFER_API_KEY is not set on motion-api' }, 503);
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const parsed = PublishBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid request (confirmation required)', issues: parsed.error.issues.slice(0, 5) }, 422);
    const body = parsed.data;
    let dueIso: string | undefined;
    if (body.mode === 'customScheduled') {
      const t = body.dueAt ? new Date(body.dueAt) : null;
      if (!t || isNaN(t.getTime())) return c.json({ error: 'dueAt is required for scheduled posts' }, 422);
      if (t.getTime() < Date.now() + 2 * 60_000) return c.json({ error: 'scheduled time must be at least 2 minutes in the future' }, 422);
      if (t.getTime() > Date.now() + 365 * 86400_000) return c.json({ error: 'scheduled time is too far away' }, 422);
      dueIso = t.toISOString();
    }
    const r = await pool.query(`${CLIP_SQL} WHERE e.id = $1`, [id]);
    if (!r.rowCount) return c.json({ error: 'episode not found' }, 404);
    const ep = shape(r.rows[0]);
    if (!ep.video_url || !ep.video_url.startsWith('https://') || !ep.video_url.startsWith(MEDIA_BASE + '/')) {
      return c.json({ error: 'video is not on the permanent public media domain', video_url: ep.video_url }, 422);
    }
    let live: buffer.Channel[];
    try { live = await buffer.channels(true); } catch (e) { return c.json({ error: `cannot load Buffer channels: ${e instanceof Error ? e.message : e}` }, 502); }

    const seen = new Set<string>();
    const plan: { ch: buffer.Channel; text: string }[] = [];
    for (const p of body.posts) {
      if (seen.has(p.channelId)) return c.json({ error: 'duplicate channel in request' }, 422);
      seen.add(p.channelId);
      const ch = live.find((x) => x.id === p.channelId);
      if (!ch) return c.json({ error: `unknown Buffer channel ${p.channelId}` }, 422);
      const svc = buffer.normService(ch.service);
      if (!(buffer.SERVICES as readonly string[]).includes(svc)) return c.json({ error: `${ch.service} is not supported by this tool` }, 422);
      if (svc === 'twitter' && p.text.length > 280) return c.json({ error: 'X/Twitter text is over 280 characters' }, 422);
      plan.push({ ch, text: p.text });
    }

    // Last line of defence against double posting: ask Buffer itself whether this video is already on each channel.
    let existing: buffer.BufferPostSummary[];
    try {
      existing = (await buffer.recentPosts({ channelIds: plan.map((x) => x.ch.id), statuses: ['needs_approval', 'scheduled', 'sending', 'sent'] }))
        .filter((p) => buffer.postUsesVideo(p, ep.video_url!));
    } catch (e) {
      return c.json({ error: `cannot check Buffer for existing posts, nothing was posted: ${e instanceof Error ? e.message : e}` }, 502);
    }
    if (existing.length) await reconcile(pool, id).catch(() => []);

    const results: any[] = [];
    for (const { ch, text } of plan) {
      if (existing.some((p) => p.channelId === ch.id)) {
        results.push({ channel_id: ch.id, service: buffer.normService(ch.service), status: 'skipped', error: 'this clip is already on this channel in Buffer' });
        continue;
      }
      const svc = buffer.normService(ch.service);
      const ins = await pool.query(
        `INSERT INTO publish_log (episode_id, channel_id, channel_name, service, mode, due_at, caption, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT DO NOTHING RETURNING id`,
        [id, ch.id, ch.displayName || ch.name, svc, body.mode, dueIso ?? null, text]);
      if (!ins.rowCount) { results.push({ channel_id: ch.id, service: svc, status: 'skipped', error: 'already published or pending for this channel' }); continue; }
      const logId = ins.rows[0].id;
      try {
        const post = await buffer.createPost({ channel: ch, text, videoUrl: ep.video_url, mode: body.mode, dueAt: dueIso, thumbnailOffsetMs: ep.thumbnail_offset_ms, aiDisclosure: AI_DISCLOSURE });
        await pool.query("UPDATE publish_log SET status='sent', buffer_post_id=$2 WHERE id=$1", [logId, post.id]);
        results.push({ channel_id: ch.id, service: svc, status: 'sent', buffer_post_id: post.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await pool.query("UPDATE publish_log SET status='failed', error=$2 WHERE id=$1", [logId, msg.slice(0, 500)]);
        results.push({ channel_id: ch.id, service: svc, status: 'failed', error: msg });
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    const anySent = results.some((x) => x.status === 'sent');
    if (anySent) await pool.query("UPDATE episodes SET ui_status='used', used_at=COALESCE(used_at, now()) WHERE id=$1", [id]);
    if (anySent) setTimeout(() => { syncPosts(pool, { limit: 10 }).then((x) => notion.syncLater(pool, [id, ...x.changed])).catch(() => notion.syncLater(pool, [id])); }, 5000);
    return c.json({ ok: results.every((x) => x.status !== 'failed'), moved_to_used: anySent, results });
  });

  // ---- analytics + integrations
  app.get('/app/api/analytics', requireUi, async (c) => {
    const days = Math.min(90, Math.max(7, Number(c.req.query('days') || 30)));
    return c.json(await analytics(pool, days));
  });

  app.post('/app/api/analytics/refresh', requireUi, async (c) => {
    const r = await syncPosts(pool, { limit: 40, force: true });
    notion.syncLater(pool, r.changed);
    return c.json(r);
  });

  app.get('/app/api/integrations', requireUi, async (c) => {
    const n = (await pool.query(`SELECT count(*) FILTER (WHERE notion_page_id IS NOT NULL)::int AS linked, count(*) FILTER (WHERE notion_error IS NOT NULL)::int AS errors,
      max(notion_synced_at) AS last, (array_agg(notion_error) FILTER (WHERE notion_error IS NOT NULL))[1] AS error FROM episodes`)).rows[0];
    return c.json({
      buffer: { configured: buffer.configured(), metrics_available: buffer.metricsAvailable() },
      notion: { configured: notion.configured(), linked: n.linked, errors: n.errors, last_synced_at: n.last, error: n.error },
      alerts: { configured: !!env.MOTION_ALERT_WEBHOOK_URL },
    });
  });

  app.post('/app/api/notion/sync', requireUi, async (c) => c.json(await notion.syncAll(pool)));

  // A 'pending' row is left only if the server died between calling Buffer and recording the answer.
  // It blocks re-posting on purpose; after checking Buffer the owner can clear it here.
  app.post('/app/api/publications/:id/clear', requireUi, async (c) => {
    const n = Number(c.req.param('id'));
    if (!Number.isInteger(n)) return c.json({ error: 'bad id' }, 400);
    const r = await pool.query("UPDATE publish_log SET status='failed', error=COALESCE(error,'cleared manually') WHERE id=$1 AND status='pending' RETURNING id", [n]);
    return c.json({ ok: r.rowCount === 1 });
  });

  // JSON export of everything worth keeping (poor man's backup, next to Railway's own Postgres backups)
  app.get('/app/api/export', requireUi, async (c) => {
    const q = async (sql: string) => (await pool.query(sql)).rows;
    const data = {
      exported_at: new Date().toISOString(),
      episodes: await q('SELECT * FROM episodes ORDER BY number NULLS LAST'),
      scripts: await q('SELECT * FROM scripts'),
      research_sources: await q('SELECT * FROM research_sources'),
      publication_handoffs: await q('SELECT * FROM publication_handoffs'),
      drafts: await q('SELECT * FROM drafts'),
      publish_log: await q('SELECT * FROM publish_log'),
    };
    c.header('content-disposition', `attachment; filename="motion-studio-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(data);
  });
  return { requireUi };
}
