import { randomUUID } from 'node:crypto';
import type { Context, Hono, Next } from 'hono';
import type pg from 'pg';
import type { discoverRankedModel, FalVideoModel } from './video-registry.js';
import type { syncVideoKnowledge } from './video-director.js';

const dataset = 'lmarena-ai/leaderboard-dataset';
const sources = {
  'text-to-video': { config: 'text_to_video', page: 'text-to-video' },
  'image-to-video': { config: 'image_to_video', page: 'image-to-video' },
  'video-editing': { config: 'video_edit', page: 'video-edit' }
} as const;
export type ArenaCategory = keyof typeof sources;
const categories = Object.keys(sources) as ArenaCategory[];
type Db = Pick<pg.Pool, 'query'>;
export type ArenaRank = {
  rank: number;
  model_id: string;
  name: string;
  provider: string;
  elo: number | null;
};
type RankedVideo = ArenaRank & { fal: FalVideoModel | null; video_to_video?: FalVideoModel | null };
export type ArenaBoard = {
  category: ArenaCategory;
  source_url: string;
  dataset_url: string;
  dataset_revision: string | null;
  source_updated_at: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  stale: boolean;
  error: string | null;
  models: RankedVideo[];
};

class ArenaDataError extends Error {}

async function getOfficial(url: URL, request: typeof fetch) {
  const response = await request(url, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new ArenaDataError('Arena dataset HTTP ' + response.status);
  }
  return response;
}

async function currentRevision(request: typeof fetch) {
  const metadata = await (
    await getOfficial(new URL('https://huggingface.co/api/datasets/' + dataset), request)
  ).json();
  if (metadata.id !== dataset || !/^[a-f0-9]{40}$/.test(metadata.sha))
    throw new ArenaDataError('Arena dataset revision unavailable');
  return metadata.sha as string;
}

// Arena publishes the overall tables in the "latest" splits of its own Hugging Face repository.
// https://arena.ai/blog/arena-leaderboard-dataset
export async function fetchArenaRanks(
  category: ArenaCategory,
  revision: string,
  request: typeof fetch = fetch
) {
  const url = new URL('https://datasets-server.huggingface.co/rows');
  url.search = new URLSearchParams({
    dataset,
    config: sources[category].config,
    split: 'latest',
    length: '100'
  }).toString();
  let date = '',
    total: number | undefined,
    offset = 0;
  const overall: ArenaRank[] = [];
  const seen = new Set<string>();
  do {
    url.searchParams.set('offset', String(offset));
    const response = await getOfficial(url, request);
    if (response.headers.get('x-revision') !== revision)
      throw new ArenaDataError('Arena dataset update is still propagating');
    const page = await response.json();
    if (
      page.partial !== false ||
      !Number.isSafeInteger(page.num_rows_total) ||
      page.num_rows_total < 1 ||
      page.num_rows_total > 5000 ||
      (total !== undefined && total !== page.num_rows_total) ||
      !Array.isArray(page.rows) ||
      page.rows.length !== Math.min(100, page.num_rows_total - offset)
    ) {
      throw new ArenaDataError('Incomplete Arena leaderboard page');
    }
    total = Number(page.num_rows_total);
    for (const item of page.rows) {
      if (item.row_idx !== offset++) throw new ArenaDataError('Unexpected Arena row order');
      const row = item.row;
      if (row?.category !== 'overall') continue;
      if (
        typeof row.model_name !== 'string' ||
        !row.model_name.trim() ||
        (row.organization != null && typeof row.organization !== 'string') ||
        !Number.isInteger(row.rank) ||
        row.rank < 1 ||
        (row.rating != null && !Number.isFinite(row.rating)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(row.leaderboard_publish_date)) ||
        (date && date !== row.leaderboard_publish_date)
      ) {
        throw new ArenaDataError('Arena overall dataset is inconsistent');
      }
      date = row.leaderboard_publish_date;
      const model_id = row.model_name.trim();
      if (seen.has(model_id)) throw new ArenaDataError('Repeated model in the Arena overall dataset');
      seen.add(model_id);
      overall.push({
        rank: row.rank,
        model_id,
        name: model_id,
        provider: row.organization?.trim() ?? '',
        elo: row.rating ?? null
      });
    }
  } while (offset < total);
  overall.sort((a, b) => a.rank - b.rank); // Stable ordering retains Arena's published order for ties.
  if (!overall.length || overall[0].rank !== 1 || overall.some((m, i) => m.rank > i + 1)) {
    throw new ArenaDataError('Missing ranks in the Arena overall dataset');
  }
  return { source_updated_at: date, models: overall.slice(0, 10) };
}

export async function readVideoArena(db: Db): Promise<{ refreshing: boolean; categories: ArenaBoard[] }> {
  const { rows } = await db.query(`SELECT s.*,s.source_updated_at::text AS published,
    (s.last_success_at IS NULL OR s.last_success_at<=now()-interval '24 hours' OR s.error IS NOT NULL) AS stale,
    coalesce(l.lease_until>now(),false) AS refreshing
    FROM video_arena_sync l LEFT JOIN video_arena_snapshots s ON true WHERE l.id=1`);
  return {
    refreshing: rows[0]?.refreshing === true,
    categories: categories.map((category) => {
      const row = rows.find((r) => r.category === category);
      return {
        category,
        source_url: 'https://arena.ai/leaderboard/video/' + sources[category].page,
        dataset_url:
          'https://huggingface.co/datasets/' + dataset + '/viewer/' + sources[category].config + '/latest',
        dataset_revision: row?.dataset_revision ?? null,
        source_updated_at: row?.published ?? null,
        last_success_at: row?.last_success_at ? new Date(row.last_success_at).toISOString() : null,
        last_attempt_at: row?.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
        stale: row?.stale ?? true,
        error: row?.error ?? null,
        models: row?.models ?? []
      };
    })
  };
}

type ArenaDeps = {
  request?: typeof fetch;
  discover?: typeof discoverRankedModel;
  knowledge?: typeof syncVideoKnowledge;
};
const leaseGuard =
  'SELECT 1 FROM video_arena_sync WHERE id=1 AND lease_token=$1 AND lease_until>now() FOR UPDATE';
export function createArenaSync(pool: pg.Pool, deps: ArenaDeps = {}) {
  async function synchronize(token: string) {
    // Each category commits independently; other boards stay readable during discovery.
    const request = deps.request ?? fetch;
    const renew = setInterval(
      () =>
        void pool
          .query(
            "UPDATE video_arena_sync SET lease_until=now()+interval '10 minutes' WHERE id=1 AND lease_token=$1",
            [token]
          )
          .catch(() => {}),
      60000
    );
    renew.unref();
    let failed = false;
    try {
      const discover = deps.discover ?? (await import('./video-registry.js')).discoverRankedModel;
      const revision = currentRevision(request);
      const verified = new Map<string, FalVideoModel>();
      // A related reference-to-video endpoint has no Arena rank. Check once per model name per refresh.
      const related = new Map<string, Promise<FalVideoModel | null>>();
      function videoToVideo(name: string) {
        const existing = related.get(name);
        if (existing) return existing;
        const discovery = discover(name, 'video-to-video');
        related.set(name, discovery);
        return discovery;
      }
      await Promise.all(
        categories.map(async (category) => {
          try {
            const sha = await revision;
            const board = await fetchArenaRanks(category, sha, request);
            const models: RankedVideo[] = [];
            // Limit discovery fan-out to one endpoint per board at a time.
            for (const row of board.models) {
              const [fal, video_to_video] = await Promise.all([
                discover(row.name, category),
                videoToVideo(row.name)
              ]);
              models.push({ ...row, fal, video_to_video });
            }
            const saved = await pool.query(
              `INSERT INTO video_arena_snapshots(category,source_updated_at,dataset_revision,models,last_success_at,last_attempt_at,error)
            SELECT $2,$3::date,$4,$5::jsonb,now(),now(),NULL WHERE EXISTS(${leaseGuard})
            ON CONFLICT(category) DO UPDATE SET source_updated_at=excluded.source_updated_at,dataset_revision=excluded.dataset_revision,
              models=excluded.models,last_success_at=excluded.last_success_at,last_attempt_at=excluded.last_attempt_at,error=NULL
              WHERE video_arena_snapshots.source_updated_at IS NULL OR excluded.source_updated_at>=video_arena_snapshots.source_updated_at`,
              [token, category, board.source_updated_at, sha, JSON.stringify(models)]
            );
            if (!saved.rowCount)
              throw new ArenaDataError(
                'Arena snapshot is older than the stored leaderboard or the sync lease expired'
              );
            for (const model of models) {
              for (const endpoint of [model.fal, model.video_to_video]) {
                if (endpoint && (endpoint.endpoint_available ?? endpoint.available)) {
                  verified.set(endpoint.endpoint_id, endpoint);
                }
              }
            }
          } catch (e) {
            failed = true;
            // Include only locally generated, public dataset diagnostics in snapshot errors.
            const error =
              e instanceof ArenaDataError
                ? e.message
                : 'เชื่อมต่อแหล่งข้อมูล Arena หรือยืนยันข้อมูล fal.ai ไม่สำเร็จ';
            await pool.query(
              `INSERT INTO video_arena_snapshots(category,error,last_attempt_at)
            SELECT $2,$3,now() WHERE EXISTS(${leaseGuard}) ON CONFLICT(category) DO UPDATE SET error=excluded.error,last_attempt_at=excluded.last_attempt_at`,
              [token, category, error]
            );
          }
        })
      );
      if (verified.size) {
        const knowledge = deps.knowledge ?? (await import('./video-director.js')).syncVideoKnowledge;
        void knowledge(pool, [...verified.values()]).catch(() =>
          console.warn('Video model knowledge sync incomplete')
        );
      }
    } finally {
      clearInterval(renew);
      await pool.query(
        "UPDATE video_arena_sync SET lease_token=NULL,lease_until=NULL,next_sync_at=now()+CASE WHEN $2::boolean THEN interval '1 hour' ELSE interval '24 hours' END WHERE id=1 AND lease_token=$1",
        [token, failed]
      );
    }
  }
  async function begin(force: boolean) {
    const token = randomUUID();
    const claim = await pool.query(
      `UPDATE video_arena_sync SET lease_token=$1,lease_until=now()+interval '10 minutes'
      WHERE id=1 AND (lease_until IS NULL OR lease_until<=now()) AND ($2::boolean OR next_sync_at<=now()) RETURNING id`,
      [token, force]
    );
    if (!claim.rowCount) return { started: false, done: Promise.resolve() };
    return { started: true, done: synchronize(token) };
  }
  return { begin };
}

export function registerVideoArena(
  app: Hono,
  pool: pg.Pool,
  guard: (c: Context, next: Next) => Promise<any>
) {
  const sync = createArenaSync(pool);
  const launch = async (force: boolean) => {
    const { done } = await sync.begin(force);
    void done.catch(() => console.error('Video leaderboard synchronization failed'));
  };
  app.get('/app/api/video-intelligence/arena', guard, async (c) => c.json(await readVideoArena(pool)));
  app.post('/app/api/video-intelligence/arena/refresh', guard, async (c) => {
    await launch(true);
    return c.json(await readVideoArena(pool), 202);
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      if (timer) return;
      const tick = () =>
        void launch(false).catch(() => console.error('Video leaderboard scheduler unavailable'));
      tick();
      timer = setInterval(tick, 60_000);
      timer.unref();
    }
  };
}
