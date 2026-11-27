import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { supportedTrends } from './product-trends.js';

const interest = { url: 'https://example.com/interest', title: 'Interest', description: 'Search interest rose by 20%' };
const sales = { url: 'https://example.co.th/sales', title: 'Sales', description: 'Reached number 2 in sales' };
const item = (source: typeof interest, kind: string) => ({
  url: source.url, kind, date: '2026-11-26', quote: source.description,
});
const evidence = [item(interest, 'demand'), item(sales, 'commerce')];
const output = (entries = evidence, other: unknown[] = []) => ({
  status: 'completed',
  output: [...other, { type: 'message', content: [{
    type: 'output_text', text: JSON.stringify([{ name: 'Example Product', evidence: entries }]),
  }] }],
});
const filter = (response: unknown, sources: (typeof interest)[] | null = [interest, sales]) =>
  supportedTrends(response, sources, '2026-11-27', '2026-10-28');

test('Firecrawl products require corroborating sources and matching excerpts', () => {
  assert.equal(filter(output())[0]?.evidence.length, 2);
  assert.deepEqual(filter(output([{ ...evidence[0], quote: 'Invented number' }, evidence[1]])), []);
  assert.deepEqual(filter(output([evidence[0], { ...evidence[1], date: '2026-10-01' }])), []);
  const subdomain = { ...sales, url: 'https://shop.example.com/sales' };
  assert.deepEqual(filter(output([evidence[0], item(subdomain, 'commerce')]), [interest, subdomain]), []);
});

test('fallback requires a web search and retrieved source URLs', () => {
  assert.deepEqual(filter(output(), null), []);
  const search = { type: 'web_search_call', status: 'completed', action: {
    type: 'search', sources: [interest, sales],
  } };
  assert.equal(filter(output(evidence, [search]), null).length, 1);
  assert.deepEqual(filter(output([evidence[0], { ...evidence[1], url: 'https://invented.example/sales' }], [search]), null), []);
});
