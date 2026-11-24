import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { Hono } from 'hono';
import { createArenaSync, fetchArenaRanks, readVideoArena, registerVideoArena } from './video-arena.js';
import type { FalVideoModel } from './video-registry.js';

const sha = 'a'.repeat(40);
const row = (rank: number, name = 'model-' + rank) => ({
  model_name: name,
  organization: 'provider',
  rating: 1400 - rank,
  rank,
  category: 'overall',
  leaderboard_publish_date: '2026-11-09'
});
const ranked = Array.from({ length: 12 }, (_, i) => row(i + 1));
type SourceRow = ReturnType<typeof row>;
function source(rows: SourceRow[], offset = 0, change: Record<string, unknown> = {}, revision = sha) {
  return Response.json(
    {
      partial: false,
      num_rows_total: rows.length,
      rows: rows.slice(offset, offset + 100).map((value, i) => ({ row_idx: offset + i, row: value })),
      ...change
    },
    { headers: { 'x-revision': revision } }
  );
}

test('uses the official latest split, traverses every page, retains actual ties and scores, and honors source order within a tie', async () => {
  const rankRows = [row(2, 'B'), row(1, 'A'), row(2, 'C'), ...ranked.slice(3)];
  rankRows[1].organization = ''; // Arena does not identify every provider.
  const all = [...Array.from({ length: 99 }, () => ({ ...row(1), category: 'style_control' })), ...rankRows];
  const offsets: number[] = [];
  const data = await fetchArenaRanks('video-editing', sha, async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://datasets-server.huggingface.co');
    assert.equal(url.searchParams.get('dataset'), 'lmarena-ai/leaderboard-dataset');
    assert.equal(url.searchParams.get('config'), 'video_edit');
    assert.equal(url.searchParams.get('split'), 'latest');
    assert.equal(options?.cache, 'no-store');
    const offset = Number(url.searchParams.get('offset'));
    offsets.push(offset);
    return source(all, offset);
  });
  assert.deepEqual(offsets, [0, 100]);
  assert.deepEqual(
    data.models.map((m) => m.rank),
    [1, 2, 2, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.deepEqual(
    data.models.slice(0, 3).map((m) => m.name),
    ['A', 'B', 'C']
  );
  assert.equal(data.models[0].provider, '');
  assert.equal(data.models[1].elo, 1398);
  assert.equal(data.source_updated_at, '2026-11-09');
});

test('fails closed on unpropagated revisions, partial pages, repeated models and invalid source ranks', async () => {
  for (const bad of [
    () => source(ranked, 0, {}, 'b'.repeat(40)),
    () => source(ranked, 0, { partial: true }),
    () => source(ranked, 0, { num_rows_total: 13 }),
    () => source([row(1, 'repeat'), row(2, 'repeat')]),
    () => source([row(1), row(3)]),
    () => source([{ ...row(1), leaderboard_publish_date: 'invalid' }])
  ]) {
    await assert.rejects(fetchArenaRanks('text-to-video', sha, async () => bad()));
  }
  const few = await fetchArenaRanks('text-to-video', sha, async () => source(ranked.slice(0, 2)));
  assert.deepEqual(
    few.models.map((x) => x.rank),
    [1, 2]
  );
});

test('durable synchronization coalesces across replicas, verifies every Top 10 row and preserves last successful data per board', async () => {
  const db = new PGlite();
  const pool = {
    query: async (sql: string, params?: any[]) => {
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }
  } as pg.Pool;
  try {
    await db.exec(await readFile(new URL('../migrations/035_video_arena.sql', import.meta.url), 'utf8'));
    const app = new Hono();
    registerVideoArena(app, pool, async (c, next) =>
      c.req.header('x-owner') === 'yes' ? await next() : c.json({}, 401)
    );
    const api = '/app/api/video-intelligence/arena';
    assert.equal((await app.request(api)).status, 401);
    assert.equal((await app.request(api + '/refresh', { method: 'POST' })).status, 401);
    const before = await (await app.request(api, { headers: { 'x-owner': 'yes' } })).json();
    assert.deepEqual(
      before.categories.map((b: any) => [b.stale, b.models.length]),
      [
        [true, 0],
        [true, 0],
        [true, 0]
      ]
    );
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let failedEdit = false,
      rollBack = false;
    let metadataReads = 0,
      providerReads = 0,
      knowledgeLookups = 0;
    const deps = {
      request: async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        if (u.hostname === 'huggingface.co') {
          metadataReads++;
          await gate;
          return Response.json({ id: 'lmarena-ai/leaderboard-dataset', sha });
        }
        const editing = u.searchParams.get('config') === 'video_edit';
        if (editing && failedEdit) return new Response('private upstream body', { status: 503 });
        return source(
          ranked.map((r) => ({
            ...r,
            leaderboard_publish_date: editing && rollBack ? '2026-09-01' : r.leaderboard_publish_date
          }))
        );
      },
      discover: async (name: string, category: any) => {
        providerReads++;
        if (name !== 'model-2' && name !== 'model-3') return null;
        return {
          name,
          category,
          available: name === 'model-2',
          endpoint_available: true,
          endpoint_id: 'provider/' + category + '/' + name,
          input_schema: {},
          schema_hash: 'test',
          checked_at: new Date().toISOString(),
          source_url: 'https://fal.ai/models/provider/' + name,
          resolutions: ['720p'],
          durations: [5],
          audio: false,
          price: null
        } as FalVideoModel;
      },
      knowledge: async (_: unknown, models: unknown[]) => {
        knowledgeLookups += models.length;
      }
    };
    const sync = createArenaSync(pool, deps);
    const first = await sync.begin(false);
    assert.equal(first.started, true);
    assert.equal((await createArenaSync(pool, deps).begin(true)).started, false);
    assert.equal((await readVideoArena(pool)).refreshing, true);
    unblock();
    await first.done;
    const initial = await readVideoArena(pool);
    assert.equal(initial.refreshing, false);
    for (const board of initial.categories) {
      assert.equal(board.error, null);
      assert.equal(board.stale, false);
      assert.equal(board.models.length, 10);
      assert.equal(board.models[0].fal, null);
      assert.equal(board.models[1].fal?.endpoint_id, 'provider/' + board.category + '/model-2');
      assert.equal(board.models[1].video_to_video?.endpoint_id, 'provider/video-to-video/model-2');
      assert.equal(Object.hasOwn(board.models[1].video_to_video!, 'rank'), false);
      assert.equal(board.models.at(-1)?.rank, 10);
      assert.match(board.dataset_url, /huggingface\.co\/datasets\/lmarena-ai/);
      assert.equal(board.dataset_revision, sha);
      assert.ok(board.last_success_at);
    }
    assert.equal((await sync.begin(false)).started, false);
    assert.deepEqual([metadataReads, providerReads, knowledgeLookups], [1, 40, 8]);
    const initialEdit = initial.categories[2];

    failedEdit = true;
    await (
      await sync.begin(true)
    ).done;
    const partial = await readVideoArena(pool);
    assert.deepEqual(
      partial.categories.map((b) => b.stale),
      [false, false, true]
    );
    const stale = partial.categories[2];
    assert.equal(stale.error, 'Arena dataset HTTP 503');
    assert.equal(stale.last_success_at, initialEdit.last_success_at);
    assert.deepEqual(stale.models, initialEdit.models);
    assert.ok(stale.last_attempt_at);
    assert.ok(stale.last_attempt_at >= initialEdit.last_attempt_at!);

    failedEdit = false;
    rollBack = true;
    await (
      await sync.begin(true)
    ).done;
    const retained = (await readVideoArena(pool)).categories[2];
    assert.equal(retained.source_updated_at, initialEdit.source_updated_at);
    assert.equal(retained.last_success_at, initialEdit.last_success_at);
    assert.equal(retained.stale, true);
    rollBack = false;
    await (
      await sync.begin(true)
    ).done;
    const fresh = await readVideoArena(pool);
    assert.equal(
      fresh.categories.every((b) => !b.stale && !b.error),
      true
    );
    assert.deepEqual([metadataReads, providerReads, knowledgeLookups], [4, 150, 28]);

    await db.exec(
      "UPDATE video_arena_snapshots SET last_success_at=now()-interval '25 hours'; UPDATE video_arena_sync SET next_sync_at=now()"
    );
    assert.equal(
      (await readVideoArena(pool)).categories.every((b) => b.stale),
      true
    );
    const scheduled = await createArenaSync(pool, deps).begin(false);
    assert.equal(scheduled.started, true);
    await scheduled.done;
    assert.deepEqual([metadataReads, providerReads, knowledgeLookups], [5, 190, 36]);
  } finally {
    await db.close();
  }
});
