import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
process.env.OPENAI_API_KEY='test-key';process.env.MOTION_LLM_PROVIDER='openai';process.env.LEMO_DEVELOPMENT='true';
const {registerStudio}=await import('./studio.js');
test('Lemo reuses the research planner, persists direction and stops before drawing or paid production',async()=>{
  const db=new PGlite();
  const query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const story=JSON.parse(readFileSync(new URL('../../lemo-worker/tests/fixtures/cats.json',import.meta.url),'utf8'));
  const board={script:story.script,character_notes:'Original orange cat, same round face and scarf throughout.',narrative:{premise:'A fictional day when cats can speak.',central_question:'What changes when cats can speak?',throughline:'A cat asks for fish and calls a meeting.',payoff:'The day ends and the cats meow again.'},sound_policy:{mode:'designed'},creative:story.creative,
    shots:story.script.map((s:any)=>({seg:s.id,visual:'An original orange cat with a fish plate in the same kitchen.',action:'The cat talks and moves its paws.',camera:'Medium shot with a gentle push.',characters:['แมวส้ม'],subjects:[{id:'cat',description:'An original orange cat acting out the narrated event.'}],continuity:{from:'The cat continues from the previous action.',to:'The cat prepares the next part of the same event.'},motion_beats:[{start:0,end:.5,action:'The cat moves its paw toward the fish.',purpose:'Illustrate the fictional request in this narration.'},{start:.5,end:1,action:'The cat reacts and turns toward the next scene.',purpose:'Carry the same character into the next story beat.'}]}))};
  const metadata={title_th:story.topic,angle:'เรื่องสมมติเมื่อแมวพูดได้',sources:[],claims:[{text:'เรื่องนี้เป็นเหตุการณ์สมมติ',kind:'assumption',source_ids:[]}],captions:{},music:'playful'};
  let calls=0,reads=0;const nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout;
  globalThis.fetch=(async(url:any,opts:any)=>{
    if(!opts.body){reads++;assert.match(String(url),/\/v1\/responses\/resp_mock_2$/);return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'submit_episode',arguments:JSON.stringify(metadata)}]}),{headers:{'content-type':'application/json'}});}
    calls++;const body=JSON.parse(opts.body);assert.equal(body.model,'gpt-6.1-sol');assert.ok(!body.tools.some((t:any)=>t.name==='draw_scene'),'Lemo planning must not draw Classic artwork');assert.ok(body.tools.find((t:any)=>t.name==='plan_story').parameters.required.includes('creative'));const name=calls===1?'plan_story':'submit_episode';return new Response(JSON.stringify({id:'resp_mock_'+calls,status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{type:'function_call',id:'fc_'+calls,call_id:'call_'+calls,name,arguments:JSON.stringify(calls===1?board:metadata)}]}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
  globalThis.setTimeout=((cb:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:cb,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{
    const app=new Hono();registerStudio(app,{query,connect:async()=>({query,release(){}})} as any,{guard:async(_c,n)=>n(),createJob:async()=>{throw Error('Unapproved production');},validate:()=>[],researchFreshness:()=>{throw Error('A fictional story with no factual claims must not be sent to factual source freshness checks');},estimateCredits:()=>0});
    const res=await app.request('/app/api/studio/drafts',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'lemo-planner-test-000001'},body:JSON.stringify({topic:story.topic,story_mode:'general',presenter_kind:'context',recurring_character:false,model:'gpt-6.1-sol',creative:{engine:'lemo'},auto_produce:true,characters:[]})});
    assert.equal(res.status,201,await res.clone().text());const {id}=await res.json() as any;
    let row:any;const deadline=Date.now()+10000;
    do{await new Promise(r=>nativeTimeout(r,20));row=(await query('SELECT * FROM drafts WHERE id=$1',[id])).rows[0];}while(!['ready','failed'].includes(row.status)&&Date.now()<deadline);
    assert.equal(row.status,'ready',JSON.stringify({error:row.error,log:row.log,problems:row.problems}));assert.equal(row.auto_produce,false);assert.equal(row.job_id,null);assert.equal(row.creative.selection.selected.id,'rubber-hose');assert.equal(calls,2,'Style is part of planning, not a third provider call');
    assert.equal((await app.request('/app/api/studio/drafts/'+id+'/produce',{method:'POST'})).status,409);
    await query("UPDATE drafts SET status='failed',draft=NULL,log=log||$2::jsonb WHERE id=$1",[id,JSON.stringify([{msg:'Saved response [resp_mock_2]'}])]);
    const recover=(response_id:string)=>app.request('/app/api/studio/drafts/'+id+'/recover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({response_id})});
    assert.equal((await recover('resp_another_draft')).status,404);assert.equal(reads,0);
    const recovered=await recover('resp_mock_2');assert.equal(recovered.status,200,await recovered.clone().text());
    assert.equal(reads,1);assert.equal(calls,2,'Recovery must never issue a paid POST');
    assert.equal((await query('SELECT status FROM drafts WHERE id=$1',[id])).rows[0].status,'ready');
    assert.equal((await recover('resp_mock_2')).status,200);assert.equal(reads,1,'Repeated recovery is idempotent');
  }finally{globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;await db.close();}
});
