import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceKey, extractWebEvidence, verifySources } from './source-evidence.js';

test('records exact page opens and in-page finds without a sources array', () => {
  const web = extractWebEvidence({ output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://stat.bora.dopa.go.th/stat/GENSTAT/STATNAME/' } },
    { type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', url: 'https://data.go.th/en/dataset/pop68', pattern: '2568' } },
  ] });
  assert.equal(web.sources.length, 2);
  assert.equal(web.sources[0].url, 'https://stat.bora.dopa.go.th/stat/GENSTAT/STATNAME/');
  assert.equal(web.searches, 0);
});

test('collects hosted sources and inline citations, deduplicating tracking links', () => {
  const web = extractWebEvidence([
    { type: 'web_search_call', action: { type: 'search', query: 'Lopburi', queries: ['Lopburi', 'monkeys'], sources: [{ url: 'https://news.dnp.go.th/news/46939?utm_source=web', title: 'DNP' }] } },
    { type: 'message', content: [{ type: 'output_text', annotations: [{ type: 'url_citation', url: 'https://news.dnp.go.th/news/46939#claim' }, { type: 'url_citation', url: 'https://en.thairath.co.th/news/local/2943122' }] }] },
  ]);
  assert.equal(web.searches, 1);
  assert.deepEqual(web.queries, ['Lopburi', 'monkeys']);
  assert.equal(web.sources.length, 2);
});

test('does not trust proposed citation arguments, failed opens, or plain answer URLs', () => {
  const web = extractWebEvidence([
    { type: 'function_call', name: 'submit_episode', arguments: JSON.stringify({ sources: [{ url: 'https://invented.example/source' }] }) },
    { type: 'web_search_call', status: 'failed', action: { type: 'open_page', url: 'https://failed.example/' } },
    { type: 'web_search_call', status: 'in_progress', action: { type: 'find_in_page', url: 'https://unfinished.example/' } },
    { type: 'message', content: [{ type: 'output_text', text: 'https://unverified.example/', annotations: [{ type: 'url_citation', url: 'file:///etc/passwd' }] }] },
  ]);
  assert.deepEqual(web.sources, []);
});

test('normalization preserves path/query case and semantic parameters', () => {
  assert.equal(sourceKey('https://Example.COM/STATNAME/?b=Two&a=ONE&utm_medium=x#part'), 'https://example.com/STATNAME?a=ONE&b=Two');
  assert.notEqual(sourceKey('https://example.com/Name?id=A'), sourceKey('https://example.com/name?id=a'));
  assert.equal(sourceKey('https://user:password@example.com/'), '');
  assert.equal(sourceKey('javascript:alert(1)'), '');
});

test('source repair uses a bounded research-only response and returns observed evidence and usage', async () => {
  const requests: any[] = [];
  const result = await verifySources(['https://data.go.th/en/dataset/pop68'], { apiKey: 'mock-key', baseUrl: 'https://api.example.test', model: 'gpt-6.1-sol', fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://data.go.th/en/dataset/pop68' } },
      { type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Population dataset; publication date not shown.' }] },
    ], usage: { input_tokens: 200, output_tokens: 30, input_tokens_details: { cached_tokens: 50 } } }), { status: 200 });
  } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].background, true);
  assert.deepEqual(requests[0].reasoning, { effort: 'low' });
  assert.equal(requests[0].max_output_tokens, 4000);
  assert.equal(requests[0].max_tool_calls, 4);
  assert.deepEqual(requests[0].tool_choice, { type: 'web_search' });
  assert.equal(result.sources[0].url, 'https://data.go.th/en/dataset/pop68');
  assert.equal(result.usage.input_tokens, 150);
  assert.equal(result.usage.cache_read_input_tokens, 50);
  assert.match(result.text, /date not shown/);
});

test('source repair never promotes requested URL when provider did not retrieve it', async () => {
  const result = await verifySources(['https://requested.example/page'], { apiKey: 'mock', baseUrl: 'https://api.example.test', model: 'gpt-6.1-sol', fetch: async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Could not access https://requested.example/page' }] }] }), { status: 200 }) });
  assert.deepEqual(result.sources, []);
  await assert.rejects(() => verifySources(['file:///private'], { apiKey: 'mock', baseUrl: 'https://api.example.test', model: 'x' }), /one to four/);
});
