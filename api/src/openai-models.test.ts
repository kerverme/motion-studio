import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOpenAIModelCatalog, DEFAULT_OPENAI_MODEL, openAIModelLabel} from './openai-models.js';

const env = {OPENAI_API_KEY:'test-only', OPENAI_BASE_URL:'https://openai.test/'};
const response = (ids:string[]) => Response.json({data:ids.map(id => ({id,object:'model'}))});

test('account discovery uses one metadata GET and accepts new general model families without a release', async () => {
  let calls = 0, clock = 10, ids = ['gpt-6.2-astra', DEFAULT_OPENAI_MODEL, 'gpt-6.2-astra', 'gpt-6.1-terra',
    'gpt-6.2-sol-2026-11-01','gpt-6.2-codex','gpt-6.2-pro','gpt-5.4-mini-realtime','gpt-4.1',
    'gpt-image-2','gpt-6.2-tts','gpt-6.2-search','whisper-1','text-embedding-3-small'];
  const catalog = createOpenAIModelCatalog({env, now:()=>clock, request:async (url,init) => {
    assert.equal(url,'https://openai.test/v1/models');assert.equal(init?.method ?? 'GET','GET');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer test-only');
    calls++;return response(ids);
  }});
  const [one,two] = await Promise.all([catalog(),catalog()]);
  assert.deepEqual(one,two);assert.equal(calls,1);assert.equal(one.source,'openai');
  assert.deepEqual(one.ids,[DEFAULT_OPENAI_MODEL,'gpt-6.2-astra','gpt-6.1-terra']);
  ids=['gpt-7.1-nova',DEFAULT_OPENAI_MODEL];clock+=15*60_000;
  assert.deepEqual((await catalog()).ids,[DEFAULT_OPENAI_MODEL,'gpt-7.1-nova']);
  assert.equal(calls,2);assert.equal(openAIModelLabel('gpt-7.1-nova'),'GPT-7.1 Nova');
});

test('outages retain the last account list, cold fallback retries and an empty valid account is authoritative', async () => {
  let clock=1, calls=0;
  const replies = [Response.json({}, {status:503}), response(['gpt-7']), Response.json({data:[{}]}), response(['gpt-image-1'])];
  const catalog=createOpenAIModelCatalog({env,now:()=>clock,request:async()=>replies[calls++]!});
  const cold=await catalog();assert.equal(cold.source,'fallback');assert.ok(cold.ids.includes(DEFAULT_OPENAI_MODEL));
  assert.equal((await catalog()).checked_at,null);assert.equal(calls,1);
  clock+=60_000;const live=await catalog();assert.deepEqual(live.ids,['gpt-7']);
  clock+=15*60_000;const stale=await catalog();assert.equal(stale.source,'cached');assert.deepEqual(stale.ids,live.ids);assert.equal(stale.checked_at,live.checked_at);
  clock+=60_000;const empty=await catalog();assert.equal(empty.source,'openai');assert.deepEqual(empty.ids,[]);
});

test('a manual metadata refresh picks up a new model before expiry and coalesces simultaneous refreshes',async()=>{
  let calls=0;
  const catalog=createOpenAIModelCatalog({env,request:async()=>response(++calls===1?['gpt-6.1-terra']:['gpt-6.2-sol','gpt-6.1-terra'])});
  await catalog();
  assert.deepEqual((await catalog()).ids,['gpt-6.1-terra']);
  const [story,trend]=await Promise.all([catalog(true),catalog(true)]);
  assert.deepEqual(story.ids,['gpt-6.2-sol','gpt-6.1-terra']);assert.deepEqual(trend,story);assert.equal(calls,2);
});

test('the idea catalog follows JSON Responses restrictions reported by the configured account',async()=>{
  const data=[{id:'gpt-7-sol',supported_endpoints:['/v1/responses'],output_modalities:['text']},
    {id:'gpt-7-astra',supported_endpoints:['/v1/audio']},{id:'gpt-7-terra',capabilities:{json_object:false}},
    {id:'gpt-7-luna',output_modalities:['image']}];
  const catalog=createOpenAIModelCatalog({env,responsesJson:true,request:async()=>Response.json({data})});
  assert.deepEqual((await catalog(true)).ids,['gpt-7-sol']);
});
