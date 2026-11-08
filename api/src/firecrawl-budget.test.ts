import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { BudgetedFirecrawl, PgResearchBudget, priceRequest } from './firecrawl-budget.js';

const job='10000000-0000-0000-0000-000000000001';
let shared:PGlite;
after(async()=>{if(shared)await shared.close();});
const fallback={webAttempted:true,reason:'The source table is missing from the OpenAI page read.'};
async function database(legacy=false) {
  const db=shared ||= new PGlite();
  await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.exec(`CREATE TABLE drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),parent_id uuid,status text,usage jsonb NOT NULL DEFAULT '{}',research jsonb NOT NULL DEFAULT '[]');`);
  if (legacy) await db.query("INSERT INTO drafts(id,usage) VALUES ($1,$2)",[job,JSON.stringify({firecrawl_calls:2})]);
  await db.exec(readFileSync(new URL('../migrations/015_research_budget.sql',import.meta.url),'utf8'));
  const client={query:async(sql:string,args:any[]=[])=>{
    // Execute migrations and ledger transactions against PostgreSQL in WASM.
    return db.query(sql,args);
  },release:()=>{}};
  const pool={...client,connect:async()=>client};
  return {db,pool:pool as any,store:new PgResearchBudget(pool as any)};
}
const page=(url='https://official.example/Report')=>({success:true,data:{markdown:'Verified published source text.',metadata:{sourceURL:url,title:'Official report',statusCode:200}}});
const api=(store:PgResearchBudget,fn:typeof fetch)=>new BudgetedFirecrawl(store,{apiKey:'mock',baseUrl:'https://mock.firecrawl',fetch:fn});

test('mixed endpoints cumulatively reserve before dispatch and never send a request beyond 25',async()=>{
  const {db,store}=await database();let calls=0;
  const fc=api(store,async(url,init)=>{
    calls++;
    const committed=(await db.query<{committed_credits:number}>('SELECT committed_credits FROM research_jobs WHERE id=$1',[job])).rows[0].committed_credits;
    assert.ok(committed>0 && committed<=25,'reservation must already be committed at HTTP dispatch');
    const body=JSON.parse(String(init?.body));
    if(String(url).endsWith('/search')) {assert.equal(body.scrapeOptions,undefined);return Response.json({success:true,data:{web:[{url:'https://official.example/Report'}]},creditsUsed:2});}
    assert.deepEqual(body.parsers,[]);assert.equal(body.proxy,'basic');assert.deepEqual(body.formats,['markdown']);
    return Response.json(page(body.url));
  });
  await fc.request(job,'/v2/search',{query:'primary source'},fallback); // reserve 12
  for(let i=0;i<4;i++)await fc.request(job,'/v2/scrape',{url:`https://official.example/${i}`},fallback); // 24 total
  assert.equal((await store.snapshot(job)).committed,24);
  await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/too-much'},fallback),/explicit owner approval/);
  assert.equal(calls,5);assert.equal((await store.snapshot(job)).remaining,1);
  // Reconstructing transport/store (restart) cannot reset spent research credits.
  const resumed=new PgResearchBudget({query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})} as any);
  await assert.rejects(api(resumed,async()=>{throw new Error('must not dispatch');}).request(job,'/v2/scrape',{url:'https://official.example/retry'},fallback),/explicit owner approval/);
  
});

test('cached extraction retains URLs and collection time and makes no paid request',async()=>{
  const {db,store}=await database();let calls=0;
  const fc=api(store,async()=>{calls++;return Response.json(page());});
  const a=await fc.request(job,'/v2/scrape',{url:'https://official.example/Report?utm_source=a'},fallback);
  const b=await fc.request(job,'/v2/scrape',{url:'https://official.example/Report'},fallback);
  assert.equal(calls,1);assert.equal(b.cache_hit,true);assert.deepEqual(b.source_urls,a.source_urls);
  assert.equal(new Date(b.collected_at).getTime(),new Date(a.collected_at).getTime(), 'cache provenance keeps the stored collection time');
  assert.equal(b.budget.committed,3);
  
});

test('unknown-cost endpoints/options/PDF/X/enrichment are blocked before dispatch or reservation',async()=>{
  const {db,store}=await database();let calls=0;const fc=api(store,async()=>{calls++;return Response.json(page());});
  for(const [path,body] of [
    ['/v2/agent',{}],['/v2/extract',{}],['/v2/crawl',{}],['/v2/batch/scrape',{}],
    ['/v2/scrape',{url:'https://x.com/account/status/123'}],['/v2/scrape',{url:'https://mobile.twitter.com/user'}],
    ['/v2/scrape',{url:'https://linkedin.com/in/person'}],['/v2/scrape',{url:'https://example.org/large.PDF?download=1'}],
    ['/v2/scrape',{url:'https://example.org/page',parsers:['pdf']}],['/v2/search',{query:'q',scrapeOptions:{formats:['markdown']}}],
  ] as [string,any][])await assert.rejects(fc.request(job,path,body,fallback));
  assert.equal(calls,0);assert.equal((await store.snapshot(job)).committed,0);
  
});

test('OpenAI first and a concrete fallback reason are enforced before the transport',async()=>{
  const {db,store}=await database();const fc=api(store,async()=>{throw new Error('must not send');});
  await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/a'},{...fallback,webAttempted:false}),/OpenAI Web Search first/);
  await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/a'},{...fallback,reason:''}),/explain/);
  assert.equal((await store.snapshot(job)).committed,0);
});

test('ambiguous timeouts retain the full reservation, block future calls and never auto-retry',async()=>{
  const {db,store}=await database();let calls=0;const fc=api(store,async()=>{calls++;throw new TypeError('fetch failed');});
  await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/a'},fallback),/uncertain/);
  await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/b'},fallback),/unresolved charge/);
  assert.equal(calls,1);const b=await store.snapshot(job);assert.equal(b.committed,3);assert.equal(b.reserved,3);assert.equal(b.blocked_reason,'uncertain_charge');
  await store.approve(job,40);assert.equal((await store.snapshot(job)).blocked_reason,'uncertain_charge','approval cannot clear unresolved charges');
  
});

test('a crash after reservation stays charged and stops later Firecrawl requests',async()=>{
  const {db,store,pool}=await database();await store.exclusive(job,()=>store.reserve(job,priceRequest('/v2/scrape',{url:'https://official.example/a'})));
  const restarted=new PgResearchBudget(pool);
  await assert.rejects(api(restarted,async()=>{throw new Error('must not send');}).request(job,'/v2/scrape',{url:'https://official.example/b'},fallback),/unresolved charge/);
  assert.equal((await restarted.snapshot(job)).committed,3);
});

test('HTTP errors, blocked pages and hidden PDFs never become evidence or retry automatically',async()=>{
  for(const response of [()=>Response.json({success:false},{status:500}),()=>Response.json({success:true,data:{markdown:'Forbidden',metadata:{statusCode:403}}}),()=>Response.json({success:true,data:{rawBase64:'JVBERi0=',markdown:''}})]){
    const {db,store}=await database();let calls=0;const fc=api(store,async()=>{calls++;return response();});
    await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/hidden'},fallback));
    await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/hidden'},fallback));
    assert.equal(calls,1);assert.equal((await store.snapshot(job)).committed,3);assert.equal((await db.query('SELECT * FROM firecrawl_cache')).rows.length,0);
    
  }
});

test('unexpected provider charges fail closed and are recorded separately',async()=>{
  const {db,store}=await database();const fc=api(store,async()=>Response.json({...page(),creditsUsed:156}));
  await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/a'},fallback),/exceeded/);
  const b=await store.snapshot(job);assert.equal(b.reported,156);assert.equal(b.blocked_reason,'cost_mismatch');
  await assert.rejects(fc.request(job,'/v2/scrape',{url:'https://official.example/b'},fallback));
});

test('approval is explicit and audited; ordinary rewrites retain one shared budget',async()=>{
  const {db,store}=await database();
  await assert.rejects(store.approve(job,25));
  const fc=api(store,async()=>Response.json(page()));await fc.request(job,'/v2/scrape',{url:'https://official.example/a'},fallback);
  const b=await store.approve(job,40);assert.equal(b.limit,40);assert.equal(b.committed,3);
  const approvals=await db.query<any>('SELECT * FROM research_budget_approvals');assert.equal(approvals.rows.length,1);assert.equal(approvals.rows[0].previous_limit,25);assert.equal(approvals.rows[0].new_limit,40);
  await db.query('INSERT INTO drafts(id,research_job_id) VALUES ($1,$2)',[job,job]);
  await db.query('INSERT INTO drafts(parent_id,research_job_id) SELECT id,research_job_id FROM drafts WHERE id=$1',[job]);
  assert.equal((await db.query('SELECT DISTINCT research_job_id FROM drafts')).rows.length,1);
  
});

test('legacy untracked usage is blocked instead of resetting a lineage to 25 fresh credits',async()=>{
  const {db,store}=await database(true);const b=await store.snapshot(job);assert.equal(b.committed,25);assert.equal(b.blocked_reason,'legacy_usage_unknown');
});

test('concurrent calls on one transport run sequentially and cannot race the budget',async()=>{
  const {db,store}=await database();let inFlight=0,maxInFlight=0,calls=0;
  const fc=api(store,async(_url,init)=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);calls++;await new Promise(r=>setTimeout(r,5));inFlight--;return Response.json(page(JSON.parse(String(init?.body)).url));});
  const results=await Promise.allSettled(Array.from({length:10},(_,i)=>fc.request(job,'/v2/scrape',{url:`https://official.example/concurrent-${i}`},fallback)));
  assert.equal(maxInFlight,1);assert.equal(calls,8);assert.equal(results.filter(x=>x.status==='fulfilled').length,8);assert.equal((await store.snapshot(job)).committed,24);
});
