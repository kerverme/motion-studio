import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {CreativeSettings,chooseStyle,classicProductionApproval,estimateCreative} from './creative.js';
import {registerCreative} from './creative-routes.js';
import {retryCreativeJob} from './creative-retry.js';

const story=JSON.parse(readFileSync(new URL('../../lemo-worker/tests/fixtures/nik.json',import.meta.url),'utf8'));
const row=(max_usd=3)=>({creative:{engine:'classic',settings:{max_usd},selection:{low_confidence:false}}});
const unknown={items:[{category:'narration',quantity:670,estimated_usd:null},{category:'sfx',quantity:4.5,estimated_usd:null},{category:'compute',quantity:1,estimated_usd:null}],unknown:['narration','sfx','compute']};

test('Classic reservations preserve the saved cap and leave unknown prices explicitly unknown',()=>{
  const result=classicProductionApproval(row(),unknown);
  assert.equal(result.available,true);
  assert.deepEqual(result.allocations,{narration:1,sfx:1,compute:1});
  assert.equal(result.max_usd,3);assert.equal(result.unknown_ack_required,true);
  const quote=estimateCreative(row(),{script:[{text:'คำทดสอบ'}],sfx:[{duration:1}]});
  assert.equal(quote.known_total_usd,0);
  assert.deepEqual(quote.unknown,['narration','sfx','compute']);
  assert.equal(quote.items.find(x=>x.category==='narration')!.estimated_usd,null);
});

test('automatic allocation handles known costs and rounding without raising the budget',()=>{
  const quote={...unknown,items:unknown.items.map((x,i)=>({...x,estimated_usd:i===0?2.25:null}))};
  const result=classicProductionApproval(row(),quote);
  assert.equal(result.available,true);
  assert.ok(result.allocations.narration>=2.25);
  assert.ok(Object.values(result.allocations).every(x=>x>0));
  assert.ok(Object.values(result.allocations).reduce((a,b)=>a+b,0)<=3);
  const tiny=classicProductionApproval(row(.0000109),unknown);
  assert.equal(tiny.available,true);
  assert.deepEqual(tiny.allocations,{narration:.000004,sfx:.000003,compute:.000003});
  assert.ok(Object.values(tiny.allocations).reduce((a,b)=>a+b,0)<=.0000109);
  assert.equal(classicProductionApproval(row(2),quote).available,false);
  assert.equal(classicProductionApproval(row(.000001),unknown).available,false);
  assert.equal(classicProductionApproval(row(NaN),unknown).available,false);
  assert.equal(classicProductionApproval(row(),{...unknown,items:[{category:'narration',quantity:NaN,estimated_usd:null}]}).available,false);
  assert.equal(classicProductionApproval(row(),{...unknown,items:[{category:'narration',quantity:1,estimated_usd:Infinity}]}).available,false);
  assert.deepEqual(classicProductionApproval(row(),{items:[{category:'compute',quantity:1,estimated_usd:0}],unknown:[]}).allocations,{compute:3});
});

test('sound cue occurrences must exist before quoting or dispatching paid narration',()=>{
  const settings=CreativeSettings.parse({engine:'classic'}),plan=structuredClone(story.creative);
  const cue=plan.scenes[0].sound.cues[0],script=structuredClone(story.script);
  script[0].text='เคาะโต๊ะ';cue.word='เคาะโต๊ะ';cue.occurrence=1;
  assert.throws(()=>chooseStyle(plan,settings,script),/Sound anchor missing.*occurrence 1/);
  script[0].text='เคาะโต๊ะ แล้วเคาะโต๊ะ';
  assert.doesNotThrow(()=>chooseStyle(plan,settings,script));
  script[0].text='...';cue.word='...';cue.occurrence=0;
  assert.throws(()=>chooseStyle(plan,settings,script),/Sound anchor missing/);
});

const db=new PGlite();let locked=Promise.resolve();
const query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
const pool={query,connect:async()=>{const prev=locked;let release!:()=>void;locked=new Promise(r=>release=r);await prev;return {query,release};}};
before(async()=>{for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));});
after(()=>db.close());
async function fixture(engine:'classic'|'lemo'='classic'){
  const settings=CreativeSettings.parse({engine,max_usd:3}),selection=chooseStyle(story.creative,settings,story.script);
  selection.low_confidence=true;
  const id=(await query("INSERT INTO drafts(topic,status,draft,storyboard,creative) VALUES($1,'ready',$2,$3,$4) RETURNING id",[story.topic,JSON.stringify({title_th:story.topic}),JSON.stringify({script:story.script,creative:story.creative}),JSON.stringify({engine,settings,selection})])).rows[0].id;
  const app=new Hono();registerCreative(app,pool as any,{guard:async(c,n)=>c.req.header('x-owner')==='yes'?n():c.json({},401),prepare:r=>({title_th:r.topic,script:story.script,storyboard:story.script.map((x:any)=>({seg:x.id})),sfx:[{duration:.5,model_id:'eleven_text_to_sound_v3'}],sources:[],voice:{model_id:'eleven_v4'}})});
  const request=(suffix:string,body?:any,owner=true)=>app.request('/app/api/creative/'+id+suffix,{method:body===undefined?'GET':'POST',headers:{...(owner?{'x-owner':'yes'}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {app,id,request};
}

test('Classic one-click approval is explicit, quote-bound and rejects stale edits or changed rates',async()=>{
  const old=process.env.MOTION_CREATIVE_RATES_JSON;delete process.env.MOTION_CREATIVE_RATES_JSON;
  try{
    const {app,id,request}=await fixture();
    const q=await(await request('/estimate')).json() as any;
    assert.equal(q.classic_approval.available,true);assert.equal(q.classic_approval.style_ack_required,true);
    const body={revision:q.revision,quote_hash:q.quote_hash,confirm:true};
    assert.equal((await request('/approve',body,false)).status,401);
    for(const invalid of [{...body,confirm:false},{revision:q.revision,quote_hash:q.quote_hash},{...body,allocations:{narration:100}},{...body,max_usd:100}])assert.equal((await request('/approve',invalid)).status,422);
    assert.equal((await app.request('/app/api/creative/'+id+'/approve',{method:'POST',headers:{'x-owner':'yes','content-type':'application/json'},body:'{'})).status,422);
    assert.equal((await request('/approve',{...body,quote_hash:'stale'})).status,409);
    await query('UPDATE drafts SET draft=$2 WHERE id=$1',[id,JSON.stringify({title_th:'Edited title'})]);
    assert.equal((await request('/approve',body)).status,409);
    const current=await(await request('/estimate')).json() as any;
    process.env.MOTION_CREATIVE_RATES_JSON=JSON.stringify({narration:{model:'eleven_v4',usd_per_unit:1,source:'test verified price',checked_at:'2026-11-17'}});
    assert.equal((await request('/approve',{revision:current.revision,quote_hash:current.quote_hash,confirm:true})).status,409);
    const over=await(await request('/estimate')).json() as any;
    assert.equal(over.classic_approval.available,false);assert.equal(over.classic_approval.max_usd,3);
    assert.equal((await request('/approve',{revision:over.revision,quote_hash:over.quote_hash,confirm:true})).status,409);
    assert.equal((await query('SELECT count(*)::int n FROM creative_approvals WHERE draft_id=$1',[id])).rows[0].n,0);
  }finally{if(old===undefined)delete process.env.MOTION_CREATIVE_RATES_JSON;else process.env.MOTION_CREATIVE_RATES_JSON=old;}
});

test('concurrent Classic confirmations queue one job and reuse its saved quote on retry',async()=>{
  const old=process.env.MOTION_CREATIVE_RATES_JSON;delete process.env.MOTION_CREATIVE_RATES_JSON;
  try{
    const {id,request}=await fixture();
    const q=await(await request('/estimate')).json() as any;
    const body={revision:q.revision,quote_hash:q.quote_hash,confirm:true};
    const results=await Promise.all([request('/approve',body),request('/approve',body)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
    const replies=await Promise.all(results.map(r=>r.json())) as any[];
    assert.equal(replies[0].id,replies[1].id);
    const job=(await query('SELECT * FROM jobs WHERE id=$1',[replies[0].id])).rows[0];
    const approvals=(await query('SELECT * FROM creative_approvals WHERE draft_id=$1',[id])).rows;
    assert.equal(approvals.length,1);assert.equal(Number(approvals[0].max_usd),3);assert.equal(approvals[0].unknown_ack,true);
    assert.deepEqual(approvals[0].allocations,q.classic_approval.allocations);
    assert.deepEqual(job.package.creative.allocations,q.classic_approval.allocations);
    assert.equal(job.kind,'episode');assert.equal(job.status,'NEW');
    assert.equal((await query('SELECT status,job_id FROM drafts WHERE id=$1',[id])).rows[0].status,'submitted');
    assert.equal((await query('SELECT count(*)::int n FROM jobs WHERE episode_id=$1',[job.episode_id])).rows[0].n,1);
    assert.equal((await query('SELECT count(*)::int n FROM creative_calls WHERE job_id=$1',[job.id])).rows[0].n,0);
    assert.equal((await request('/approve',body)).status,200);
    assert.equal((await request('/approve',{...body,quote_hash:'wrong'})).status,409);
  }finally{if(old===undefined)delete process.env.MOTION_CREATIVE_RATES_JSON;else process.env.MOTION_CREATIVE_RATES_JSON=old;}
});

test('Lemo cannot use Classic simple confirmation and retains its existing advanced quote',async()=>{
  const {id,request}=await fixture('lemo');const q=await(await request('/estimate')).json() as any;
  assert.equal(q.classic_approval,undefined);
  assert.equal((await request('/approve',{revision:q.revision,quote_hash:q.quote_hash,confirm:true})).status,409);
  assert.equal((await query('SELECT count(*)::int n FROM creative_approvals WHERE draft_id=$1',[id])).rows[0].n,0);
});

async function failedClassic(options:{kind?:string;engine?:string;call_key?:string;provider?:string;model?:string;category?:string;provider_id?:string;status?:string}={}){
  const episode=(await query("INSERT INTO episodes(topic,title_th,status) VALUES('retry test','retry test','FAILED') RETURNING id")).rows[0].id;
  const stages={GENERATING_AUDIO:{narration_key:'saved-voice',sfx_manifest:[{audio_key:'saved-fx'}]},BUILDING_TIMELINE:{timeline_key:'saved-timing'}};
  const job=(await query("INSERT INTO jobs(episode_id,kind,status,package,stage_results,attempts,finished_at) VALUES($1,$2,'FAILED',$3,$4,3,now()) RETURNING id",[episode,options.kind||'episode',JSON.stringify({creative:{engine:options.engine||'classic'}}),JSON.stringify(stages)])).rows[0].id;
  await query('INSERT INTO creative_calls(job_id,call_key,provider,model,category,request_hash,reserved_usd,status,provider_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[job,options.call_key||'classic-render-v1',options.provider||'infrastructure',options.model||'classic',options.category||'compute','same-request',.25,options.status||'uncertain',options.provider_id||null]);
  await query("INSERT INTO creative_calls(job_id,call_key,provider,model,category,request_hash,reserved_usd,status,result) VALUES($1,'saved-tts','elevenlabs','eleven_v4','narration','saved-request',.15,'complete',$2)",[job,JSON.stringify({audio_key:'saved-voice'})]);
  return {job,episode,stages};
}

test('Classic failed local-render retry preserves one reservation, paid assets and the original job',async()=>{
  const {job,episode,stages}=await failedClassic();
  const app=new Hono();registerCreative(app,pool as any,{guard:async(c,n)=>c.req.header('x-owner')==='yes'?n():c.json({},401),prepare:()=>{throw Error('Retry must not create another production package');}});
  const request=(owner=true)=>app.request('/app/api/creative/jobs/'+job+'/retry',{method:'POST',headers:owner?{'x-owner':'yes'}:{}});
  assert.equal((await request(false)).status,401);
  const responses=await Promise.all([request(),request()]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const saved=(await query('SELECT * FROM jobs WHERE id=$1',[job])).rows[0];
  assert.equal(saved.status,'NEW');assert.equal(saved.episode_id,episode);assert.equal(saved.attempts,0);assert.equal(saved.finished_at,null);
  assert.deepEqual(saved.stage_results,stages);
  const calls=(await query('SELECT * FROM creative_calls WHERE job_id=$1 ORDER BY call_key',[job])).rows;
  assert.equal(calls.length,2);
  assert.equal(calls[0].status,'reserved');assert.equal(Number(calls[0].reserved_usd),.25);assert.equal(calls[0].request_hash,'same-request');
  assert.equal(calls[1].status,'complete');assert.deepEqual(calls[1].result,{audio_key:'saved-voice'});
  assert.equal((await query('SELECT count(*)::int n FROM jobs WHERE episode_id=$1',[episode])).rows[0].n,1);
});

test('retry never reopens ambiguous external requests or a worker-held job',async()=>{
  const blocked=await failedClassic();
  await query("INSERT INTO creative_calls(job_id,call_key,provider,model,category,request_hash,reserved_usd,status) VALUES($1,'uncertain-tts','elevenlabs','eleven_v4','narration','pending-request',.2,'uncertain')",[blocked.job]);
  assert.equal((await retryCreativeJob(pool as any,blocked.job)).ok,false);
  assert.equal((await query("SELECT status FROM creative_calls WHERE job_id=$1 AND call_key='classic-render-v1'",[blocked.job])).rows[0].status,'uncertain');
  for(const options of [{call_key:'another-render'},{provider:'fal'},{model:'another-model'},{category:'coding'},{kind:'lemo',engine:'lemo'},{kind:'episode',engine:'lemo'},{kind:'lemo',engine:'classic'}]){
    const {job}=await failedClassic(options);
    const result=await retryCreativeJob(pool as any,job);
    assert.equal(result.ok,false,JSON.stringify(options));
    assert.equal((await query('SELECT status FROM jobs WHERE id=$1',[job])).rows[0].status,'FAILED');
  }
  const active=await failedClassic();
  await query("UPDATE jobs SET locked_until=now()+interval '10 minutes',locked_by='still-rendering' WHERE id=$1",[active.job]);
  const busy=await retryCreativeJob(pool as any,active.job);assert.equal(busy.ok,false);assert.match(busy.error!,/worker still holds/);
  const pollable=await failedClassic({provider:'openai',model:'gpt-6.1-sol',category:'coding',provider_id:'resp_saved',call_key:'saved-response',status:'started'});
  assert.equal((await retryCreativeJob(pool as any,pollable.job)).ok,true);
  assert.equal((await query("SELECT status FROM creative_calls WHERE job_id=$1 AND call_key='saved-response'",[pollable.job])).rows[0].status,'started','a known OpenAI response resumes GET polling without resetting its request');
});
