import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {processResearchQueue} from './trends/run-job.js';
import {researchResponse,ResearchResponsePending} from './trends/provider.js';

const db=new PGlite(),originalFetch=globalThis.fetch;
const pool:any={query:(sql:string,args:any[]=[])=>db.query(sql,args)};
const tick=(workerId=randomUUID())=>processResearchQueue(pool,pool,workerId,()=>{});
const chosen='gpt-6.2-sol';
before(async()=>{
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()){
    await db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  }
});
after(async()=>{globalThis.fetch=originalFetch;await db.close();});
async function job(withEvidence:boolean) {
  const id=randomUUID(),budget=randomUUID(),stamp=new Date(Date.now()-60_000).toISOString();
  const evidence=withEvidence?[1,2].map(i=>({platform:'tiktok',sourceId:String(i),content:'คำบรรยายจากแหล่งจริง',available:true,detailRead:true,author:'creator'+i,publishedAt:stamp,observedAt:stamp})):[];
  const checkpoint={social_complete:true,plan:{summary:'เว็บ',queries:[]},web_attempted:true,web_sources:[],calls:[],warnings:[],evidence};
  const request={platform:'tiktok',model:chosen,count:5,query:'เรื่องใกล้ตัว',audience:'คนไทย'};
  await db.query("INSERT INTO trend_research_runs(id,request_key,request,status) VALUES($1::uuid,$1::text,$2,'queued')",[id,JSON.stringify(request)]);
  await db.query('INSERT INTO research_jobs(id) VALUES($1)',[budget]);
  await db.query('INSERT INTO trend_alexandria_jobs(run_id,request_id,request_hash,budget_id,checkpoint) VALUES($1::uuid,$1::uuid,$1::text,$2,$3)',[id,budget,JSON.stringify(checkpoint)]);
  return id;
}
const detail=async(id:string)=>(await db.query<any>('SELECT r.*,j.state FROM trend_research_runs r JOIN trend_alexandria_jobs j ON j.run_id=r.id WHERE r.id=$1',[id])).rows[0];
const background=(id:string,status:string)=>Response.json({id,status,...(status==='completed'?{usage:{input_tokens:20,output_tokens:9},output:[{type:'message',content:[{type:'output_text',text:'{"patterns":[]}'}]}]}:{})});

test('slow scoring yields the queue, survives five minutes and a worker restart, and reads the same response through a temporary outage',async()=>{
  const id=await job(true),other=await job(false),paths:string[]=[];
  const answers=[()=>background('resp_slow','queued'),()=>background('resp_slow','in_progress'),()=>new Response('{}',{status:503}),()=>background('resp_slow','completed')];
  globalThis.fetch=async(url,init)=>{
    const path=new URL(String(url)).pathname;paths.push((init?.method||'GET')+' '+path);
    if(init?.method==='POST'){const body=JSON.parse(String(init.body));assert.equal(body.model,chosen);assert.equal(body.background,true);}
    const next=answers.shift();assert.ok(next,'unexpected provider call');return next();
  };
  const worker=randomUUID();await tick(worker);assert.equal((await detail(id)).state,'queued');assert.equal((await detail(id)).details.openai_stage,'score');
  await tick(worker);assert.equal((await detail(other)).state,'partial','another job progressed between reads');
  await db.query("UPDATE trend_provider_calls SET created_at=now()-interval '6 minutes' WHERE research_run_id=$1",[id]);
  await db.query("UPDATE trend_alexandria_jobs SET state='running' WHERE run_id=$1",[id]);
  await tick();assert.equal((await detail(id)).state,'queued');
  await tick();assert.equal((await detail(id)).state,'queued');assert.equal((await detail(id)).error,null);
  await tick();const final=await detail(id);assert.equal(final.state,'partial');assert.equal(final.evidence_count,2);assert.equal(final.details.openai_stage,undefined);
  assert.deepEqual(paths,['POST /v1/responses',...Array(3).fill('GET /v1/responses/resp_slow')]);
  assert.equal((await db.query('SELECT * FROM trend_provider_calls WHERE research_run_id=$1',[id])).rows.length,1);
});

test('only a confirmed cancellation of the approved response can create one replacement and both ledger entries survive',async()=>{
  const id=await job(false);await db.query("UPDATE trend_alexandria_jobs SET state='failed' WHERE run_id=$1",[id]);
  const old='resp_cancelled_score',base=id+':score';
  await db.query("INSERT INTO trend_provider_calls(research_run_id,call_key,model,status,response_id,reserved_usd) VALUES($1,$2,$3,'failed',$4,.12)",[id,base,chosen,old]);
  const sent:string[]=[];
  globalThis.fetch=async(url,init)=>{
    sent.push((init?.method||'GET')+' '+new URL(String(url)).pathname);
    if(String(url).endsWith('/'+old))return background(old,'cancelled');
    if(init?.method==='POST')return background('resp_replacement','queued');
    return background('resp_replacement','completed');
  };
  const resume=(approved?:string)=>researchResponse(pool,id,'score',{input:'เก็บข้อมูลเดิม'},Date.now()+60000,chosen,{replace_cancelled:!!approved,response_id:approved});
  await assert.rejects(resume(),/ถูกยกเลิก/);
  await assert.rejects(resume('resp_another'),/ถูกยกเลิก/);
  await assert.rejects(resume(old),ResearchResponsePending);
  assert.equal((await resume(old)).status,'completed');await resume(old);
  assert.deepEqual(sent,['GET /v1/responses/'+old,'POST /v1/responses','GET /v1/responses/resp_replacement']);
  const rows=await db.query<any>('SELECT call_key,status,response_id,reserved_usd FROM trend_provider_calls WHERE research_run_id=$1 ORDER BY created_at',[id]);
  assert.deepEqual(rows.rows.map(r=>[r.call_key,r.status,r.response_id]),[[base,'failed',old],[base+':after_cancel','done','resp_replacement']]);
  assert.equal(Number(rows.rows[0].reserved_usd),.12);
});

test('a 30-minute waiting window parks a known response without cancellation and a manual check resumes by GET',async()=>{
  const id=await job(false);await db.query("UPDATE trend_alexandria_jobs SET state='failed' WHERE run_id=$1",[id]);
  await db.query("INSERT INTO trend_provider_calls(research_run_id,call_key,model,response_id,created_at) VALUES($1,$2,$3,'resp_long',now()-interval '35 minutes')",[id,id+':planner',chosen]);
  let reads=0;globalThis.fetch=async(url,init)=>{assert.equal(init?.method,'GET');assert.ok(String(url).endsWith('/resp_long'));return background('resp_long',++reads===3?'completed':'in_progress');};
  const check=(at?:string)=>researchResponse(pool,id,'planner',null,Date.now()+60000,chosen,{at,response_id:'resp_long'});
  await assert.rejects(check(),/30 นาที/);const now=new Date().toISOString();await assert.rejects(check(now),ResearchResponsePending);
  assert.equal((await check(now)).status,'completed');assert.equal(reads,3);
});
