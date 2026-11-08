import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiResponse } from './openai-response.js';

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status });
const queued = () => json({ id: 'resp_test', status: 'queued' });
const done = () => json({ id: 'resp_test', status: 'completed', output: [{ type: 'function_call', arguments: '{}' }], usage: { output_tokens: 12 } });
const disconnected = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection lost'), { code: 'UND_ERR_SOCKET' }) }); };
function harness(steps: (() => Response)[], sleepStep?: number) {
  let time = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  const progress: string[] = [];
  const options = {
    apiKey: 'test-secret', baseUrl: 'https://example.invalid',
    now: () => time,
    sleep: async (ms: number) => { time += sleepStep ?? ms; },
    onProgress: async (msg: string) => { progress.push(msg); },
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      const step = steps.shift();
      assert.ok(step, 'unexpected request');
      return step();
    }) as typeof fetch,
  };
  return { options, calls, progress };
}

test('polls one response beyond five minutes; keeps tool output and usage', async () => {
  const h = harness([queued, () => json({ id: 'resp_test', status: 'in_progress' }), done], 180_000);
  const result = await openaiResponse({ model: 'chosen-model', input: 'story', tools: [{ type: 'web_search' }] }, h.options);
  assert.equal(result.usage.output_tokens, 12);
  assert.equal(result.output[0].type, 'function_call');
  assert.deepEqual(h.calls.map(c => c.init?.method), ['POST', 'GET', 'GET']);
  assert.equal(JSON.parse(String(h.calls[0].init?.body)).background, true);
  assert.equal(JSON.parse(String(h.calls[0].init?.body)).model, 'chosen-model');
  assert.ok(h.progress.some(x => x.includes('3 นาที')));
});

test('retries failed reads of the same response without creating another', async () => {
  const h = harness([queued, disconnected, () => json({ error: {} }, 503), done]);
  await openaiResponse({}, h.options);
  assert.equal(h.calls.filter(c => c.init?.method === 'POST').length, 1);
  assert.ok(h.calls.slice(1).every(c => c.url.endsWith('/resp_test')));
});

test('never retries ambiguous creation failures or exposes keys', async () => {
  for (const step of [disconnected, () => json({ error: {} }, 502), () => new Response('bad JSON')]) {
    const h = harness([step]);
    await assert.rejects(openaiResponse({}, h.options), (e: Error) => !e.message.includes('test-secret') && e.message.includes('OpenAI'));
    assert.equal(h.calls.length, 1);
  }
});

test('quota exhaustion stops immediately; explicit rate rejection can retry', async () => {
  const q = harness([() => json({ error: { code: 'insufficient_quota' } }, 429)]);
  await assert.rejects(openaiResponse({}, q.options), /insufficient_quota/);
  assert.equal(q.calls.length, 1);
  const rate = harness([() => json({ error: { code: 'rate_limit_exceeded' } }, 429), done]);
  assert.equal((await openaiResponse({}, rate.options)).status, 'completed');
});

test('rejects failed/cancelled/missing response IDs; preserves incomplete output for composer', async () => {
  for (const response of [{ status: 'queued' }, { id: 'resp_test', status: 'failed', error: { code: 'server_error' } }, { id: 'resp_test', status: 'cancelled' }, {}]) {
    const h = harness([() => json(response)]);
    await assert.rejects(openaiResponse({}, h.options), /OpenAI/);
  }
  const h = harness([() => json({ id: 'resp_test', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } })]);
  assert.equal((await openaiResponse({}, h.options)).status, 'incomplete');
});

test('deadline cancels the accepted response and identifies unconfirmed cancellation', async () => {
  for (const cancel of [() => json({ status: 'cancelled' }), disconnected]) {
    const h = harness([queued, cancel]);
    await assert.rejects(openaiResponse({}, { ...h.options, timeoutMs: 1 }), /เกินเวลารอต่อรอบ.*resp_test/);
    assert.ok(h.calls[1].url.endsWith('/resp_test/cancel'));
  }
});

test('preserves completion racing cancellation and ignores progress persistence errors', async () => {
  const h = harness([queued, done]);
  const result = await openaiResponse({}, { ...h.options, timeoutMs: 1, onProgress: async () => { throw new Error('DB temporarily down'); } });
  assert.equal(result.status, 'completed');
});
