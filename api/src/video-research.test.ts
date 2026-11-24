import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cachedDirectorResearch,verifyDirectorSources} from './video-research.js';

const db=new PGlite();
after(()=>db.close());
const client={query:db.query.bind(db),release(){}};
const pool={...client,connect:async()=>client} as any;
async function reset() {
  await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),parent_id uuid,status text,usage jsonb NOT NULL DEFAULT '{}',research jsonb NOT NULL DEFAULT '[]');");
  for(const f of ['015_research_budget','040_video_director_research']) await db.exec(readFileSync(new URL('../migrations/'+f+'.sql',import.meta.url),'utf8'));
}
const job='a0000000-0000-4000-8000-000000000000',url='https://official.example/paper';
const claim='The experiment recorded a change across the samples.';
const args={topic:'A scientific topic',source_text:''};
const refs=[{url,claim}];
const call=(action:unknown)=>({output:[{type:'web_search_call',status:'completed',action}]});

test('fiction uses no research, verified reads are reused for the same content and claim only',async()=>{
  await reset();
  assert.deepEqual(await verifyDirectorSources(pool,job,{},[],args),{sources:[],evidence:[]});
  assert.equal((await db.query('SELECT * FROM research_jobs')).rows.length,0);
  const live=await verifyDirectorSources(pool,job,call({type:'open_page',url}),refs,args);
  assert.equal(live.evidence[0].method,'openai_page');
  assert.deepEqual(await cachedDirectorResearch(pool,args),live);
  assert.equal(await cachedDirectorResearch(pool,{...args,source_text:'different source'}),null);
  const again=await verifyDirectorSources(pool,'b0000000-0000-4000-8000-000000000000',{},refs,args);
  assert.deepEqual(again,live);
  await assert.rejects(verifyDirectorSources(pool,job,{},[{url,claim:'a new claim'}],args),/หลักฐาน/);
  await db.exec("UPDATE video_director_research SET verified_at=now()-interval '25 hours'");
  assert.equal(await cachedDirectorResearch(pool,args),null);
});

test('fallback requires primary tool evidence, exact supporting passage and bounded credits',async()=>{
  await reset();let requests=0;
  const opts={firecrawlKey:'test',fetch:async()=>{requests++;return Response.json({success:true,data:{markdown:'Published report. '+claim,metadata:{sourceURL:url}},creditsUsed:1});}};
  const result={type:'search',sources:[{url}]};
  await assert.rejects(verifyDirectorSources(pool,job,{output:[{type:'message',content:[{annotations:[{type:'url_citation',url}]}]}]},refs,args,opts),/หลักฐาน/);
  await assert.rejects(verifyDirectorSources(pool,job,call(result),[{url:url+'/invented',claim}],args,opts),/หลักฐาน/);
  assert.equal(requests,0);
  const r=await verifyDirectorSources(pool,job,call(result),refs,args,opts);
  assert.equal(r.evidence[0].method,'firecrawl_passage');assert.equal(requests,1);
  await assert.rejects(verifyDirectorSources(pool,job,call(result),[{url,claim:'This conflicting number is unsupported.'}],args,opts),/ข้อความสนับสนุน/);
  assert.equal(requests,1,'rechecking the actual page must reuse its cached extraction');
  const data=(await db.query<any>('SELECT committed_credits,credit_limit FROM research_jobs WHERE id=$1',[job])).rows[0];
  assert.deepEqual(data,{committed_credits:3,credit_limit:25});
});
