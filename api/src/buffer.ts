// Buffer GraphQL client (https://developers.buffer.com). The API key lives only in the BUFFER_API_KEY env var.
// createPost is never retried automatically: a retry after an ambiguous failure could publish twice.
const env = process.env;
const API_URL = env.BUFFER_API_URL || 'https://api.buffer.com';

export type Channel = { id: string; name: string; displayName?: string | null; service: string; avatar?: string | null };
export type PublishMode = 'shareNow' | 'addToQueue' | 'customScheduled';

export function configured() {
  return !!env.BUFFER_API_KEY;
}

// Serialise a JS value as a GraphQL literal. Keys listed in ENUM_KEYS carry enum values that must not be quoted.
const ENUM_KEYS = new Set(['schedulingType', 'mode', 'type']);
function lit(v: unknown, key = ''): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return ENUM_KEYS.has(key) ? v.replace(/[^A-Za-z0-9_]/g, '') : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => lit(x)).join(', ') + ']';
  if (typeof v === 'object') {
    return '{' + Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => `${k}: ${lit(x, k)}`).join(', ') + '}';
  }
  throw new Error('unsupported literal');
}

export class BufferError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message);
  }
}

async function gql<T>(query: string, tries = 1): Promise<T> {
  if (!env.BUFFER_API_KEY) throw new BufferError('BUFFER_API_KEY is not set on motion-api');
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.BUFFER_API_KEY}` },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      if (r.status === 429) throw new BufferError('Buffer rate limit reached; try again later', 429, true);
      if (r.status === 401 || r.status === 403) throw new BufferError('Buffer rejected the API key', r.status);
      let body: { data?: T; errors?: { message: string }[] };
      try { body = JSON.parse(text); } catch { throw new BufferError(`Buffer returned HTTP ${r.status} (not JSON)`, r.status, r.status >= 500); }
      if (body.errors?.length) throw new BufferError(body.errors.map((e) => e.message).join('; ').slice(0, 500), r.status);
      if (!r.ok || !body.data) throw new BufferError(`Buffer HTTP ${r.status}`, r.status, r.status >= 500);
      return body.data;
    } catch (e) {
      last = e;
      const retryable = e instanceof BufferError ? e.retryable : true;
      if (!retryable || i === tries - 1) break;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new BufferError(String(last));
}

let orgCache: { id: string; name: string } | null = null;
export async function organization() {
  if (orgCache) return orgCache;
  const d = await gql<{ account: { organizations: { id: string; name: string }[] } }>('query { account { organizations { id name } } }', 2);
  const orgs = d.account.organizations;
  if (!orgs.length) throw new BufferError('No Buffer organization found for this API key');
  const want = env.BUFFER_ORGANIZATION_ID;
  const org = (want ? orgs.find((o) => o.id === want) : orgs[0]) ?? orgs[0];
  orgCache = org;
  return org;
}

let chCache: { at: number; list: Channel[] } | null = null;
export async function channels(force = false): Promise<Channel[]> {
  if (!force && chCache && Date.now() - chCache.at < 60_000) return chCache.list;
  const org = await organization();
  const d = await gql<{ channels: Channel[] }>(`query { channels(input: {organizationId: ${JSON.stringify(org.id)}}) { id name displayName service avatar } }`, 2);
  chCache = { at: Date.now(), list: d.channels };
  return d.channels;
}

export const SERVICES = ['instagram', 'facebook', 'tiktok', 'twitter'] as const;
export function normService(s: string) {
  const x = (s || '').toLowerCase();
  return x === 'x' ? 'twitter' : x;
}

export type PostRequest = {
  channel: Channel;
  text: string;
  videoUrl: string;
  mode: PublishMode;
  dueAt?: string;
  thumbnailOffsetMs?: number;
  aiDisclosure?: boolean;
};

export function buildInput(p: PostRequest) {
  const svc = normService(p.channel.service);
  const input: Record<string, unknown> = {
    text: p.text,
    channelId: p.channel.id,
    schedulingType: 'automatic',
    mode: p.mode,
    assets: [{ video: { url: p.videoUrl, ...(p.thumbnailOffsetMs != null && svc !== 'facebook' && svc !== 'twitter' ? { metadata: { thumbnailOffset: p.thumbnailOffsetMs } } : {}) } }],
  };
  if (p.mode === 'customScheduled') input.dueAt = p.dueAt;
  if (svc === 'instagram') input.metadata = { instagram: { type: 'reel', shouldShareToFeed: true, ...(p.aiDisclosure ? { isAiGenerated: true } : {}) } };
  else if (svc === 'facebook') input.metadata = { facebook: { type: 'reel' } };
  else if (svc === 'tiktok') input.metadata = { tiktok: { ...(p.aiDisclosure ? { isAiGenerated: true } : {}) } };
  return input;
}

export function buildMutation(p: PostRequest) {
  return `mutation { createPost(input: ${lit(buildInput(p))}) { ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`;
}

export type PostInfo = {
  id: string; status: string; sentAt?: string | null; dueAt?: string | null; externalLink?: string | null;
  error?: { message: string } | null; metrics?: { type: string; value: number; unit: string }[] | null; metricsUpdatedAt?: string | null;
};

// Reading metrics needs the insightsRead scope on the API key. If it is missing, keep tracking status without metrics.
let metricsDeniedUntil = 0;
export function metricsAvailable() {
  return Date.now() >= metricsDeniedUntil;
}
export async function getPost(id: string): Promise<{ post: PostInfo | null; metrics: boolean }> {
  const base = 'id status sentAt dueAt externalLink error { message }';
  const q = (withM: boolean) => `query { post(input: {id: ${JSON.stringify(id)}}) { ${base}${withM ? ' metrics { type value unit } metricsUpdatedAt' : ''} } }`;
  if (metricsAvailable()) {
    try {
      const d = await gql<{ post: PostInfo | null }>(q(true), 2);
      return { post: d.post, metrics: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/scope|insight|permission|forbidden|not authori[sz]ed/i.test(msg)) throw e;
      metricsDeniedUntil = Date.now() + 3600_000;
    }
  }
  const d = await gql<{ post: PostInfo | null }>(q(false), 2);
  return { post: d.post, metrics: false };
}

export type BufferPostSummary = { id: string; status: string; channelId: string; createdAt: string; assets: { source?: string | null; thumbnail?: string | null }[] };

// Recent posts of the organisation (optionally per channel). Used to detect a clip that is already in Buffer,
// whether it was posted from this UI, retried inside Buffer, or posted by hand.
export async function recentPosts(opts: { channelIds?: string[]; statuses?: string[]; first?: number } = {}): Promise<BufferPostSummary[]> {
  const org = await organization();
  const st = (opts.statuses ?? ['needs_approval', 'scheduled', 'sending', 'sent', 'error']).map((s) => s.replace(/[^a-z_]/g, '')).join(', ');
  const ch = opts.channelIds?.length ? `, channelIds: ${JSON.stringify(opts.channelIds)}` : '';
  const q = `query { posts(first: ${opts.first ?? 100}, input: {organizationId: ${JSON.stringify(org.id)}, filter: {status: [${st}]${ch}}}) { edges { node { id status channelId createdAt assets { source thumbnail } } } } }`;
  const d = await gql<{ posts: { edges: { node: BufferPostSummary }[] } }>(q, 2);
  return d.posts.edges.map((e) => ({ ...e.node, status: String(e.node.status || '').toLowerCase() }));
}

// Buffer may re-host the video (TikTok), so also look for our URL inside the thumbnail link it generates.
export function postUsesVideo(p: BufferPostSummary, videoUrl: string) {
  const enc = encodeURIComponent(videoUrl);
  let dec = videoUrl;
  try { dec = decodeURI(videoUrl); } catch { /* keep */ }
  return (p.assets || []).some((a) => {
    const src = a.source || '', th = a.thumbnail || '';
    return src === videoUrl || src === dec || th.includes(enc) || th.includes(encodeURIComponent(dec));
  });
}

export async function createPost(p: PostRequest): Promise<{ id: string; status?: string; dueAt?: string | null }> {
  const d = await gql<{ createPost: { post?: { id: string; status?: string; dueAt?: string | null }; message?: string } }>(buildMutation(p), 1);
  if (d.createPost.post) return d.createPost.post;
  throw new BufferError(d.createPost.message || 'Buffer refused the post');
}
