import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {registerReverse} from './reverse.js';
import {sha,validatePlan,defaultMethod,validateSemantic} from './reverse-contract.js';
import {generationTask,routerEstimate} from './reverse-providers.js';
import {catalogModels,catalogTask} from './reverse-catalog.js';
const db=new PGlite();let serial=Promise.resolve();
const query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return{...r,rowCount:r.affectedRows??r.rows.length};};
const pool={query,connect:async()=>{const previous=serial;let release!:()=>void;serial=new Promise(r=>release=r);await previous;return{query,release};}};
const headers={'content-type':'application/json','x-test-auth':'yes'};
const path='/app/api/reverse';let priceUnit='units';let pricesRead=0;
function server(){const app=new Hono();registerReverse(app,pool as any,{guard:async(c,next)=>c.req.header('x-test-auth')==='yes'?next():c.json({error:'unauthorized'},401),prices:async ids=>{pricesRead++;return ids.map(endpoint_id=>({endpoint_id,unit:priceUnit,unit_price:.01,currency:'USD'}));},tokenRate:async model=>({model,input:.000001,output:.000004,request:0,modalities:['text','video'],source:'test fixture',checked_at:new Date().toISOString(),published_pricing:{prompt:'0.000001',completion:'0.000004'}})});return app;}
const send=(app:Hono,url:string,body:any,method='POST')=>app.request(path+url,{method,headers,body:JSON.stringify(body)});
const input=()=>({origin_key:'test:'+randomUUID(),title:'Owned acceptance fixture',source:{sha256:'a'.repeat(64),bytes:100,filename:'reference.mp4',content_type:'video/mp4'}});
const analysis=()=>({schema:'motion.reverse.analysis.v1',source:{width:480,height:854},video_md:'# VIDEO.md\nMeasured fixture',shots:[1,2].map(i=>({id:'shot_00'+i,start_s:i-1,end_s:i,duration_s:1,frame_count:24,clip:{asset_id:randomUUID(),sha256:'b'.repeat(64),duration_s:8,stretch:8,audio_included:false},semantic:null,source_evidence:{timing:'measured'}}))});
async function create(app:Hono){const r=await send(app,'/projects',input());assert.equal(r.status,201,await r.clone().text());const p=await r.json();await query('UPDATE reverse_projects SET analysis=$2 WHERE id=$1',[p.id,JSON.stringify(analysis())]);return(await(await app.request(path+'/projects/'+p.id,{headers})).json());}
const shot=(id='shot_001')=>({shot_id:id,prompt:'New blue robot raises its hand in a quiet new moon laboratory, warm light, locked camera.',method:'generative',model:'h3_max',settings:{resolution:'768P'},references:[],characters:{},location:null,audio:[],subtitle_mode:'none',continuity_group:'',handoff_previous_frame:false,qa_criteria:['Correct visible action and character'],human_reviewed:false});
const plan=(p:any)=>({schema:'motion.reverse.production.v1',project_id:p.id,source_sha256:p.source_sha256,analysis_sha256:p.analysis_sha256,base_revision:p.current_revision,origin:'user',delivery_promise:'reference_remake',recipe_id:null,shots:[shot(),shot('shot_002')],uncertainty:[]});
before(async()=>{const dir=new URL('../migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(f,dir),'utf8'));await query("INSERT INTO integrations(provider,data) VALUES('reverse_worker',$1)",[JSON.stringify({runtime:{installed:true},fal:true,eleven:true,key_fingerprints:{fal:'test-key'},voice_id:'owner-voice'})]);});
after(()=>db.close());

test('new namespace requires owner auth; config/page reads never request provider metadata or enqueue',async()=>{
  const app=server(),before=pricesRead;assert.equal((await app.request(path+'/projects')).status,401);assert.equal((await app.request(path+'/config',{headers})).status,200);assert.equal(pricesRead,before);assert.equal((await query('SELECT count(*)::int AS n FROM creative_calls')).rows[0].n,0);
});
test('source identity is idempotent and cannot mutate a project; additive tables preserve legacy jobs',async()=>{
  const app=server(),i=input(),first=await(await send(app,'/projects',i)).json();assert.equal((await(await send(app,'/projects',i)).json()).id,first.id);assert.equal((await send(app,'/projects',{...i,source:{...i.source,sha256:'c'.repeat(64)}})).status,409);
  const old=(await query("INSERT INTO jobs(kind,status,package) VALUES('episode','NEW','{\"legacy\":true}') RETURNING id")).rows[0];await create(app);assert.deepEqual((await query('SELECT package FROM jobs WHERE id=$1',[old.id])).rows[0].package,{legacy:true});
});
test('one-shot edits version plans, preserve other shots, reject stale edits/analysis and invented timing',async()=>{
  const app=server(),p=await create(app),initial=plan(p),saved=await(await send(app,'/projects/'+p.id+'/plan',initial,'PUT')).json();assert.ok(saved.revision);const changed=structuredClone(saved.plan);changed.base_revision=saved.revision;changed.shots[0].prompt='A new red astronaut walks slowly across a moon garden.';
  const result=await(await send(app,'/projects/'+p.id+'/plan',changed,'PUT')).json();assert.deepEqual(result.plan.shots[1],saved.plan.shots[1]);assert.notEqual(result.revision,saved.revision);assert.equal((await send(app,'/projects/'+p.id+'/plan',changed,'PUT')).status,409);
  assert.throws(()=>validatePlan({...initial,analysis_sha256:'0'.repeat(64)},p),/analysis changed/);assert.throws(()=>validatePlan({...initial,shots:[{...shot(),duration_s:999}]},p));assert.throws(()=>validatePlan({...initial,origin:'planner',shots:[{...shot(),method:'code'}]},p),/graphics/);
});
test('Vision quote is read-only; approval is source/analysis/amount/key bound, durable and idempotent',async()=>{
  const app=server(),p=await create(app),url='/projects/'+p.id,body={purpose:'vision',shot_ids:['shot_001'],model:'google/gemini-3.8-flash'};
  let res=await send(app,url+'/quote',body);assert.equal(res.status,200,await res.clone().text());const q=await res.json();assert.ok(q.total_usd>0);assert.equal(q.tasks.length,1);assert.equal(q.tasks[0].payload.video_urls,undefined,'private video goes only in the worker POST');
  assert.equal((await query("SELECT count(*)::int AS n FROM jobs WHERE kind='reverse'")).rows[0].n,0);
  const a={quote_id:q.id,binding:q.binding,accepted_usd:q.total_usd,source_confirmed:true,rights_confirmed:true,approval_origin:'revideo_owner_ui'};
  assert.equal((await send(app,url+'/approve',{...a,accepted_usd:0})).status,409);assert.equal((await send(app,url+'/approve',{...a,source_confirmed:false})).status,409);
  const results=await Promise.all([send(app,url+'/approve',a),send(app,url+'/approve',a)]);assert.deepEqual(results.map(r=>r.status),[202,200]);const jobs=await Promise.all(results.map(r=>r.json()));assert.equal(jobs[0].job_id,jobs[1].job_id);
  assert.equal((await query('SELECT count(*)::int AS n FROM creative_approvals WHERE job_id=$1',[jobs[0].job_id])).rows[0].n,1);assert.equal((await query('SELECT count(*)::int AS n FROM creative_calls')).rows[0].n,0,'API cannot dispatch paid calls');
  res=await send(app,url+'/quote',body);const stale=await res.json();await query("UPDATE reverse_projects SET analysis=jsonb_set(analysis,'{semantic_status}','\"changed\"') WHERE id=$1",[p.id]);assert.equal((await send(app,url+'/approve',{...a,quote_id:stale.id,binding:stale.binding,accepted_usd:stale.total_usd})).status,409);
});
test('changed billing units and unverified capabilities block paid quotes; generated references cannot be implicit source pixels',async()=>{
  const app=server(),p=await create(app);priceUnit='tokens';assert.equal((await send(app,'/projects/'+p.id+'/quote',{purpose:'vision',shot_ids:['shot_001']})).status,409);priceUnit='units';
  const s:any=shot();s.human_reviewed=true;s.method='code';assert.throws(()=>generationTask({...s,method:'generative',model:'invented/model'},p.analysis.shots[0],[]),/verified/);assert.equal(defaultMethod({production_method:{label:'motion_graphics'}}),'code');assert.equal(defaultMethod({production_method:{label:'live_action'}}),'generative');
  const estimate=routerEstimate({system_prompt:'abc',prompt:'ภาษาไทย',max_tokens:100},{input:.000001,output:.000004,request:0},8);assert.ok(estimate.usd>.003);assert.equal(estimate.output_token_cap,100);
});
test('all catalog entries stay visible and verified prices use a bounded freshness window even without a promotion deadline',t=>{
  t.mock.method(Date,'now',()=>Date.parse('2026-11-13T12:00:00Z'));const models=catalogModels();assert.equal(models.length,120);assert.equal(models.filter((x:any)=>x.available).length,59);
  const cheap=models.find((x:any)=>x.id==='fal-ai/ltx-video-13b-distilled');assert.equal(cheap?.available,true);assert.ok(Date.parse(cheap!.price_valid_until)>Date.now());
  const s:any={...shot(),model:cheap!.id,human_reviewed:true,settings:{resolution:cheap!.preset_resolution,aspect_ratio:'9:16'}};
  const task=catalogTask(s,{duration_s:1},[{endpoint_id:s.model,unit:'video',unit_price:.04,currency:'USD'}]);assert.equal(task.usd,.04);assert.equal(task.payload.num_frames,121);
  assert.throws(()=>catalogTask({...s,references:[{asset_id:randomUUID(),role:'first_frame',rights_confirmed:true,allow_source_reference:false}]},{duration_s:1},[]),/text-to-video/);
  t.mock.method(Date,'now',()=>Date.parse('2026-11-15T12:00:00Z'));assert.equal(catalogModels().filter((x:any)=>x.available).length,0);
});
