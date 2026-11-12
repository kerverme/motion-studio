import { Hono, type Context, type Next } from 'hono';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { z } from 'zod';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { registerUi } from './ui.js';
import * as buffer from './buffer.js';
import { alertSweep, retention } from './ops.js';
import { syncPosts } from './metrics.js';
import { registerStudio, configured as studioConfigured, OPENAI_MODELS } from './studio.js';
import { registerTopicSuggestions } from './topic-suggestions.js';
import { registerNarrationPreviews } from './narration-previews.js';
import { registerTextVideo } from './text-video.js';
import { registerCommunity } from './community.js';
import * as notion from './notion.js';

const env = process.env;
const PORT = Number(env.PORT || 8080);
const API_TOKEN = env.MOTION_API_TOKEN || '';
const INTERNAL_TOKEN = env.MOTION_INTERNAL_TOKEN || '';
const MAX_CREDITS = Number(env.MOTION_MAX_CREDITS_PER_EPISODE || 6000);
const PUBLIC_URL = env.MOTION_PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

// ---------------------------------------------------------------- migrations
async function migrate() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(424242)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log(`migration applied: ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    c.release();
  }
}

// ---------------------------------------------------------------- helpers
function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function requireAuth(c: Context, next: Next) {
  const h = c.req.header('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!API_TOKEN || !tok || !safeEq(tok, API_TOKEN)) return c.json({ error: 'unauthorized' }, 401);
  await next();
}

function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

const s3 = env.BUCKET
  ? new S3Client({
      region: env.BUCKET_REGION || 'auto',
      endpoint: env.BUCKET_ENDPOINT,
      forcePathStyle: (env.BUCKET_URL_STYLE || 'virtual') === 'path',
      credentials: { accessKeyId: env.BUCKET_ACCESS_KEY_ID || '', secretAccessKey: env.BUCKET_SECRET_ACCESS_KEY || '' },
    })
  : null;

// ---------------------------------------------------------------- package schema
const Cue = z.object({
  seg: z.string(),
  word: z.string().optional(),
  n: z.number().int().min(0).default(0),
  at: z.enum(['start', 'end']).optional(),
  offset: z.number().default(0),
  gain: z.number().min(0).max(2).default(0.8),
});
const Package = z.object({
  topic: z.string().min(3),
  title_th: z.string().min(2).max(120),
  series_tag: z.string().max(60).optional(),
  script: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]+$/), text: z.string().min(1) })).min(1).max(30),
  voice: z.object({
    voice_id: z.string().min(5),
    model_id: z.string().default('eleven_v4'),
    language_code: z.string().default('th'),
    stability: z.number().min(0).max(1).default(0.4),
    similarity_boost: z.number().min(0).max(1).default(0.75),
    speed: z.number().min(0.7).max(1.2).optional(),
  }),
  music: z.object({ source: z.enum(['generate', 'default']).default('generate'), prompt: z.string().min(5), model_id: z.string().default('music_v1'), volume: z.number().min(0).max(1).default(0.3) }).nullable().optional(),
  sfx: z.array(z.object({ id: z.string(), prompt: z.string().min(3), duration: z.number().min(0.5).max(30), cues: z.array(Cue).min(1) })).max(40).default([]),
  scene_code: z.string().min(50),
  storyboard: z.array(z.record(z.any())).default([]),
  direction: z.object({version:z.literal(1),narrative:z.record(z.any()),shots:z.array(z.record(z.any())),sound_policy:z.object({mode:z.enum(['designed','quiet']),owner_quote:z.string().optional()}),motion_review:z.string().optional()}).optional(),
  sources: z.array(z.object({
    url: z.string().url(), publisher: z.string().optional(), title: z.string().optional(), published: z.string().optional(),
    collected: z.string().optional(), methodology: z.string().optional(), confidence: z.enum(['high', 'medium', 'low']).optional(),
    limitations: z.string().optional(), claim: z.string().optional(),
    retrieved_via: z.string().optional(),   // 'firecrawl' (search or scrape) or 'openai_web_search' (OpenAI's hosted web search, used when Firecrawl is out of credits)
    freshness_note: z.string().optional(),  // why an older figure is still the latest available (e.g. a 10-yearly census)
  })).default([]),
  claims: z.array(z.object({ text: z.string(), source_ids: z.array(z.number().int().min(0)).default([]), kind: z.enum(['fact', 'assumption', 'opinion', 'community']).default('fact') })).default([]),
  captions: z.record(z.string()).default({}),
  thumbnail: z.object({ mode: z.literal('opening_frame').optional(), seg: z.string(), offset: z.number().default(1.5), title: z.string().optional() }).optional(),
  cover: z.object({ who: z.string().max(20), name: z.string().min(1).max(20), line: z.string().max(40).optional() }).optional(),
  style: z.enum(['classic', 'pixel_art', 'ps2', 'comic', 'lego', 'claymation', 'paper_cutout', 'retro_anime', 'low_poly', 'risograph', 'diorama']).default('classic'),
  budget: z.object({ max_credits: z.number().int().positive() }).optional(),
});
type Pkg = z.infer<typeof Package>;

// Research rule (owner's standing instruction, 2026-11-04): facts behind a story come from live Firecrawl searches,
// using the most recent data available. Each source must say it was retrieved with Firecrawl, when it was collected
// (within MOTION_SOURCE_MAX_AGE_DAYS) and when it was published; anything published more than MOTION_SOURCE_MAX_YEARS
// years ago needs a freshness_note explaining why nothing newer exists. MOTION_REQUIRE_FIRECRAWL=false turns this off.
function researchFreshness(p: Pkg): string[] {
  if ((env.MOTION_REQUIRE_FIRECRAWL || 'true') === 'false') return [];
  const maxAge = Number(env.MOTION_SOURCE_MAX_AGE_DAYS || 30), maxYears = Number(env.MOTION_SOURCE_MAX_YEARS || 2);
  const thisYear = new Date().getFullYear();
  const out: string[] = [];
  if (!p.sources.length) out.push('no sources listed');
  p.sources.forEach((s, i) => {
    const tag = `source ${i} (${s.url})`;
    if (!['firecrawl', 'openai_web_search'].includes((s.retrieved_via || '').toLowerCase())) out.push(`${tag}: retrieved_via must be "firecrawl" or "openai_web_search"`);
    const col = s.collected ? new Date(s.collected) : null;
    if (!col || isNaN(col.getTime())) out.push(`${tag}: collected date missing or not a date`);
    else if (Date.now() - col.getTime() > maxAge * 86400_000) out.push(`${tag}: collected more than ${maxAge} days ago, search again`);
    // accepts Gregorian (2026) and Thai Buddhist-era (2569 = 2026) years
    const m = (s.published || '').match(/(?:19|20|25)\d{2}/)?.[0];
    const yr = m ? (Number(m) >= 2400 ? Number(m) - 543 : Number(m)) : 0;
    if (!yr) out.push(`${tag}: published date or year missing`);
    else if (thisYear - yr > maxYears && !(s.freshness_note && s.freshness_note.trim().length >= 10)) out.push(`${tag}: published ${yr}; use newer data or add freshness_note explaining why this is the latest available`);
  });
  return out;
}

// Credit estimate. Rates observed on this workspace: TTS ~1 credit/char, music ~15 credits/s, SFX ~3.4 credits/s.
function estimateCredits(p: Pkg) {
  const chars = p.script.reduce((n, s) => n + s.text.length + 1, 0);
  const speechSecs = chars / 12; // ~12 Thai chars per second of narration
  const music = p.music && p.music.source !== 'default' ? Math.ceil((speechSecs + 3) * 15) : 0;   // the default track is reused, not generated
  const sfx = p.sfx.reduce((n, s) => n + Math.ceil(s.duration * 3.4), 0);
  return Math.ceil(chars * 1.05) + music + sfx;
}

async function event(jobId: string, message: string, data?: unknown, level = 'info', status?: string) {
  await pool.query('INSERT INTO job_events (job_id, status, level, message, data) VALUES ($1,$2,$3,$4,$5)', [jobId, status ?? null, level, message, data ?? null]);
}

// ---------------------------------------------------------------- app
const app = new Hono();

app.get('/', (c) => c.json({ service: 'motion-api', ok: true }));
app.get('/health', async (c) => {
  try {
    const r = await pool.query('SELECT count(*)::int AS jobs FROM jobs');
    const g = await pool.query("SELECT 1 FROM integrations WHERE provider='google_drive'");
    return c.json({ ok: true, db: 'up', jobs: r.rows[0].jobs, drive_connected: g.rowCount === 1, auth_configured: !!API_TOKEN, ui_enabled: !!env.MOTION_UI_PASSWORD, buffer_configured: buffer.configured(), notion_configured: notion.configured(), studio: studioConfigured(), alerts_configured: !!env.MOTION_ALERT_WEBHOOK_URL, retention_days: Number(env.MOTION_RETENTION_DAYS || 0) || null });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 503);
  }
});

app.post('/jobs', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid json' }, 400);
  const r = await createJob(body, c.req.header('idempotency-key') || null);
  return c.json(r.body, r.status as 200);
});

// Validates and queues a job. Used by POST /jobs and by the content studio (topic -> generated package).
async function createJob(body: any, idem: string | null): Promise<{ status: number; body: any }> {
  const c = { json: (b: any, status = 200) => ({ status, body: b }) };
  const kind = (body.kind as string) || 'episode';
  if (!['episode', 'test_tts', 'test_render', 'test_drive'].includes(kind)) return c.json({ error: 'unknown kind' }, 400);
  let pkg: unknown = body.package ?? {};
  let estimated = 0;
  let budget = Math.min(MAX_CREDITS, 600);
  let topic = (body.topic as string) || kind;
  let title = (body.title_th as string) || kind;
  if (kind === 'episode' || (kind === 'test_render' && body.package)) {
    const parsed = Package.safeParse(body.package);
    if (!parsed.success) return c.json({ error: 'invalid package', issues: parsed.error.issues.slice(0, 20) }, 422);
    const p = parsed.data;
    const segIds = new Set(p.script.map((s) => s.id));
    if (segIds.size !== p.script.length) return c.json({ error: 'duplicate script segment ids' }, 422);
    for (const fx of p.sfx) for (const cue of fx.cues) if (!segIds.has(cue.seg)) return c.json({ error: `sfx ${fx.id} cue refers to unknown segment ${cue.seg}` }, 422);
    const fresh = researchFreshness(p);
    if (fresh.length) return c.json({ error: 'research sources do not meet the freshness rule', problems: fresh }, 422);
    const unsupported = p.claims.filter((cl) => cl.kind === 'fact' && (cl.source_ids.length === 0 || cl.source_ids.some((i) => i >= p.sources.length)));
    if (unsupported.length) return c.json({ error: 'factual claims without a valid source', claims: unsupported.map((u) => u.text) }, 422);
    estimated = estimateCredits(p);
    budget = Math.min(MAX_CREDITS, p.budget?.max_credits ?? MAX_CREDITS);
    if (estimated > budget) return c.json({ error: 'estimated cost exceeds budget', estimated_credits: estimated, budget_credits: budget }, 402);
    pkg = p;
    topic = p.topic;
    title = p.title_th;
  }
  const sha = sha256(stableStringify({ kind, pkg }));
  if (idem) {
    const ex = await pool.query('SELECT id, status FROM jobs WHERE idempotency_key=$1', [idem]);
    if (ex.rowCount) return c.json({ id: ex.rows[0].id, status: ex.rows[0].status, duplicate: true }, 200);
  }
  const dup = await pool.query("SELECT id, status FROM jobs WHERE package_sha256=$1 AND status NOT IN ('FAILED','CANCELLED') ORDER BY created_at DESC LIMIT 1", [sha]);
  if (dup.rowCount && !body.force) return c.json({ id: dup.rows[0].id, status: dup.rows[0].status, duplicate: true }, 200);

  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    let episodeId: string | null = null;
    if (kind === 'episode') {
      const p = pkg as Pkg;
      const ep = await cl.query('INSERT INTO episodes (topic, title_th, status) VALUES ($1,$2,$3) RETURNING id', [p.topic, p.title_th, 'NEW']);
      episodeId = ep.rows[0].id;
      await cl.query('INSERT INTO scripts (episode_id, segments, full_text) VALUES ($1,$2,$3)', [episodeId, JSON.stringify(p.script), p.script.map((s) => s.text).join(' ')]);
      for (const [i, s] of p.script.entries()) {
        const sb = p.storyboard.find((b) => b.seg === s.id) ?? null;
        await cl.query('INSERT INTO scenes (episode_id, seg_id, position, storyboard) VALUES ($1,$2,$3,$4)', [episodeId, s.id, i, sb]);
      }
      for (const src of p.sources) {
        await cl.query('INSERT INTO research_sources (episode_id, claim, url, publisher, published, collected, methodology, confidence, limitations) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [episodeId, src.claim ?? null, src.url, src.publisher ?? null, src.published ?? null, src.collected ?? null, src.methodology ?? null, src.confidence ?? null, src.limitations ?? null]);
      }
    }
    // Research, fact-checking, scripting and scene coding are done by Claude before submission;
    // the job starts at GENERATING_AUDIO and those earlier stages are recorded as completed.
    const status = kind === 'episode' ? 'GENERATING_AUDIO' : 'NEW';
    const job = await cl.query(
      `INSERT INTO jobs (episode_id, kind, status, package, package_sha256, idempotency_key, budget_credits, estimated_credits)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status, created_at`,
      [episodeId, kind, status, JSON.stringify(pkg), sha, idem, budget, estimated]);
    const id = job.rows[0].id;
    if (kind === 'episode') {
      for (const st of ['NEW', 'RESEARCHING', 'FACT_CHECKING', 'SCRIPTING', 'CODING_ANIMATION']) {
        await cl.query('INSERT INTO job_events (job_id, status, message) VALUES ($1,$2,$3)', [id, st, 'completed by Claude before submission']);
      }
      await cl.query('UPDATE episodes SET status=$2 WHERE id=$1', [episodeId, status]);
    }
    await cl.query('INSERT INTO job_events (job_id, status, message, data) VALUES ($1,$2,$3,$4)', [id, status, 'job queued', JSON.stringify({ estimated_credits: estimated, budget_credits: budget })]);
    await cl.query('COMMIT');
    return c.json({ id, status, episode_id: episodeId, estimated_credits: estimated, budget_credits: budget, topic, title_th: title }, 201);
  } catch (e) {
    await cl.query('ROLLBACK');
    throw e;
  } finally {
    cl.release();
  }
}

app.get('/jobs', requireAuth, async (c) => {
  const r = await pool.query(`SELECT j.id, j.kind, j.status, j.stage, j.progress, j.error, j.created_at, j.updated_at, e.number, e.title_th, e.drive_folder_url
    FROM jobs j LEFT JOIN episodes e ON e.id=j.episode_id ORDER BY j.created_at DESC LIMIT 50`);
  return c.json({ jobs: r.rows });
});

async function loadJob(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await pool.query(`SELECT j.*, e.number AS episode_number, e.title_th, e.drive_folder_url FROM jobs j LEFT JOIN episodes e ON e.id=j.episode_id WHERE j.id=$1`, [id]);
  return r.rows[0] ?? null;
}

app.get('/jobs/:id', requireAuth, async (c) => {
  const j = await loadJob(c.req.param('id'));
  if (!j) return c.json({ error: 'not found' }, 404);
  const { package: pkg, ...rest } = j;
  return c.json({ ...rest, package_summary: { topic: pkg?.topic, title_th: pkg?.title_th, segments: pkg?.script?.length, sfx: pkg?.sfx?.length } });
});

app.get('/jobs/:id/status', requireAuth, async (c) => {
  const j = await loadJob(c.req.param('id'));
  if (!j) return c.json({ error: 'not found' }, 404);
  const ev = await pool.query('SELECT status, level, message, data, created_at FROM job_events WHERE job_id=$1 ORDER BY id DESC LIMIT 40', [j.id]);
  return c.json({ id: j.id, kind: j.kind, status: j.status, stage: j.stage, progress: j.progress, error: j.error, attempts: j.attempts,
    used_credits: Number(j.used_credits), estimated_credits: j.estimated_credits, episode_number: j.episode_number, drive_folder_url: j.drive_folder_url,
    result: j.result, qa: j.qa_report, events: ev.rows.reverse() });
});

app.get('/jobs/:id/assets', requireAuth, async (c) => {
  const j = await loadJob(c.req.param('id'));
  if (!j) return c.json({ error: 'not found' }, 404);
  const r = await pool.query('SELECT kind, storage_key, bytes, sha256, meta, created_at FROM assets WHERE job_id=$1 ORDER BY id', [j.id]);
  const out = [];
  for (const a of r.rows) {
    let url: string | null = null;
    if (s3 && env.BUCKET) url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET, Key: a.storage_key }), { expiresIn: 3600 });
    out.push({ ...a, url });
  }
  return c.json({ assets: out });
});

async function retryJob(id: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  const j = await loadJob(id);
  if (!j) return { ok: false, error: 'not found' };
  if (!['FAILED', 'CANCELLED'].includes(j.status)) return { ok: false, error: `job is ${j.status}` };
  if (j.kind === 'text_video') return {ok:false,error:'เปิด Text to Video แล้วตรวจราคาซ่อมเฉพาะส่วนและยืนยันใหม่ก่อนลองต่อ'};
  const resume = j.stage || 'GENERATING_AUDIO';
  await pool.query('UPDATE jobs SET status=$2, error=NULL, attempts=0, locked_by=NULL, locked_until=NULL, updated_at=now() WHERE id=$1', [j.id, resume]);
  await event(j.id, 'retry requested; resuming from last completed stage', null, 'info', resume);
  return { ok: true, status: resume };
}

app.post('/jobs/:id/retry', requireAuth, async (c) => {
  const j = await loadJob(c.req.param('id'));
  if (!j) return c.json({ error: 'not found' }, 404);
  const r = await retryJob(j.id);
  return r.ok ? c.json({ id: j.id, status: r.status }) : c.json({ error: r.error }, 409);
});

app.post('/jobs/:id/cancel', requireAuth, async (c) => {
  const j = await loadJob(c.req.param('id'));
  if (!j) return c.json({ error: 'not found' }, 404);
  await pool.query("UPDATE jobs SET status='CANCELLED', updated_at=now() WHERE id=$1 AND status NOT IN ('READY_TO_POST','CANCELLED')", [j.id]);
  await event(j.id, 'cancelled', null, 'warn', 'CANCELLED');
  return c.json({ id: j.id, status: 'CANCELLED' });
});

// ---------------------------------------------------------------- Google Drive OAuth (one-time connect)
const G_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
function signState(v: string) {
  return createHmac('sha256', API_TOKEN || 'x').update(v).digest('hex').slice(0, 32);
}

app.get('/oauth/google/start', async (c) => {
  const key = c.req.query('key') || '';
  if (!API_TOKEN || !safeEq(key, API_TOKEN)) return c.text('Add ?key=<MOTION_API_TOKEN> to start the Google Drive connection.', 401);
  if (!env.GOOGLE_OAUTH_CLIENT_ID) return c.text('GOOGLE_OAUTH_CLIENT_ID is not set on motion-api.', 500);
  const nonce = randomBytes(12).toString('hex');
  const state = `${nonce}.${signState(nonce)}`;
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID);
  u.searchParams.set('redirect_uri', `${PUBLIC_URL}/oauth/google/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', G_SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  return c.redirect(u.toString());
});

app.get('/oauth/google/callback', async (c) => {
  const state = c.req.query('state') || '';
  const [nonce, sig] = state.split('.');
  if (!nonce || !sig || !safeEq(sig, signState(nonce))) return c.text('Invalid state.', 400);
  const code = c.req.query('code');
  if (!code) return c.text(`Google returned: ${c.req.query('error') || 'no code'}`, 400);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_OAUTH_CLIENT_ID || '', client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      redirect_uri: `${PUBLIC_URL}/oauth/google/callback`, grant_type: 'authorization_code',
    }),
  });
  const tok = (await r.json()) as Record<string, unknown>;
  if (!r.ok || !tok.refresh_token) return c.text(`Token exchange failed: ${JSON.stringify({ error: tok.error, description: tok.error_description })}`, 400);
  let email: string | null = null;
  try {
    const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { authorization: `Bearer ${tok.access_token}` } });
    email = ((await about.json()) as { user?: { emailAddress?: string } }).user?.emailAddress ?? null;
  } catch { /* ignore */ }
  await pool.query(`INSERT INTO integrations (provider, data, updated_at) VALUES ('google_drive', $1, now())
    ON CONFLICT (provider) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [JSON.stringify({ refresh_token: tok.refresh_token, scope: tok.scope, email })]);
  return c.html(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>Google Drive connected ✓</h2><p>${email ?? ''}</p><p>Motion Studio can now deliver episodes to “Motion Studio / Ready to Post”. You can close this tab.</p></body>`);
});

// worker-only: short-lived Drive access token (client secret never leaves motion-api)
app.get('/internal/google/access-token', async (c) => {
  const t = c.req.header('x-internal-token') || '';
  if (!INTERNAL_TOKEN || !safeEq(t, INTERNAL_TOKEN)) return c.json({ error: 'forbidden' }, 403);
  const g = await pool.query("SELECT data FROM integrations WHERE provider='google_drive'");
  if (!g.rowCount) return c.json({ error: 'google drive not connected', connect_url: `${PUBLIC_URL}/oauth/google/start?key=<MOTION_API_TOKEN>` }, 409);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID || '', client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET || '', refresh_token: g.rows[0].data.refresh_token, grant_type: 'refresh_token' }),
  });
  const tok = (await r.json()) as Record<string, unknown>;
  if (!r.ok) return c.json({ error: 'refresh failed', detail: tok.error }, 502);
  return c.json({ access_token: tok.access_token, expires_in: tok.expires_in });
});

const ui = registerUi(app, pool, { API_TOKEN, retryJob });
const suggestions = registerTopicSuggestions(app,pool,{guard:ui.requireUi,models:OPENAI_MODELS});
const narrationPreviews = registerNarrationPreviews(app,pool,{guard:ui.requireUi,models:OPENAI_MODELS});
const textVideo = registerTextVideo(app,pool,{guard:ui.requireUi,models:OPENAI_MODELS});
const studio = registerStudio(app, pool, { guard: ui.requireUi, createJob, estimateCredits: (p: unknown) => estimateCredits(Package.parse(p)), researchFreshness: (p: unknown) => researchFreshness(Package.parse(p)), validate: (p: unknown) => {
  const r = Package.safeParse(p);
  return r.success ? [] : r.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
} });
registerCommunity(app, pool, { guard: ui.requireUi, newDraft: studio.newCommunityDraft });

// ---------------------------------------------------------------- operations
app.post('/ops/retention', requireAuth, async (c) => {
  const apply = c.req.query('apply') === '1' && env.MOTION_RETENTION_APPLY === 'true';
  return c.json(await retention(pool, s3, apply));
});
app.post('/ops/alerts', requireAuth, async (c) => c.json(await alertSweep(pool)));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

await migrate();
suggestions.start().catch(e=>console.error('topic suggestions startup', e instanceof Error ? e.message : 'failed'));
narrationPreviews.start().catch(e=>console.error('narration previews startup', e instanceof Error ? e.message : 'failed'));
textVideo.start().catch(e=>console.error('text video startup', e instanceof Error ? e.message : 'failed'));
// Buffer post status + metrics every 10 minutes; changed episodes are mirrored to Notion
setInterval(() => {
  syncPosts(pool).then((r) => notion.syncLater(pool, r.changed)).catch((e) => console.error('post sync', e instanceof Error ? e.message : e));
}, 10 * 60_000).unref();
// Notion: new or failed rows every 5 minutes, full refresh every 6 hours
setInterval(async () => {
  if (!notion.configured()) return;
  const ids = (await pool.query(`SELECT DISTINCT h.episode_id FROM publication_handoffs h JOIN episodes e ON e.id = h.episode_id
    WHERE e.notion_page_id IS NULL OR e.notion_synced_at IS NULL OR e.notion_error IS NOT NULL`).catch(() => ({ rows: [] }))).rows.map((r: any) => r.episode_id);
  notion.syncLater(pool, ids);
}, 5 * 60_000).unref();
setInterval(() => { notion.syncAll(pool).catch(() => {}); }, 6 * 3600_000).unref();
setTimeout(() => { notion.syncAll(pool).then((r) => console.log('notion sync', JSON.stringify(r))).catch(() => {}); }, 30_000).unref();
setInterval(() => { alertSweep(pool).catch((e) => console.error('alert sweep', e instanceof Error ? e.message : e)); }, 60_000).unref();
if (Number(env.MOTION_RETENTION_DAYS || 0) >= 3) {
  const run = () => retention(pool, s3, env.MOTION_RETENTION_APPLY === 'true').then((r) => console.log('retention', JSON.stringify(r))).catch((e) => console.error('retention', e instanceof Error ? e.message : e));
  setTimeout(run, 60_000).unref();
  setInterval(run, 24 * 3600_000).unref();
}
serve({ fetch: app.fetch, port: PORT, hostname: env.HOST || '::' }, (i) => console.log(`motion-api listening on ${i.port}`));
