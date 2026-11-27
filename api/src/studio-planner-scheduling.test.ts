import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Hono} from 'hono';
import pg from 'pg';
import {CreativeSettings,chooseStyle} from './creative.js';

process.env.MOTION_LLM_PROVIDER='openai';
process.env.OPENAI_API_KEY='mock-only';
process.env.OPENAI_BASE_URL='https://planner-fixture.invalid';
process.env.MOTION_OPENAI_WEB_SEARCH='true';
delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('./studio.js');

test('two replicas advance new drafts while an existing request waits, then resume by receipt', {
  skip:!process.env.STUDIO_PLANNER_TEST_DATABASE_URL,timeout:25000,
},async t=>{
  const primary=new pg.Pool({connectionString:process.env.STUDIO_PLANNER_TEST_DATABASE_URL});
  const replica=new pg.Pool({connectionString:process.env.STUDIO_PLANNER_TEST_DATABASE_URL});
  t.after(async()=>{await primary.end();await replica.end();});
  assert.equal((await primary.query('SELECT current_database() AS name')).rows[0].name,'studio_planner_test');
  const dir=new URL('../migrations/',import.meta.url);
  await primary.query('CREATE TABLE schema_migrations (name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){
    await primary.query(readFileSync(new URL(f,dir),'utf8'));
    await primary.query('INSERT INTO schema_migrations(name) VALUES($1)',[f]);
  }
  const story=JSON.parse(readFileSync(new URL('../../lemo-worker/tests/fixtures/dream.json',import.meta.url),'utf8'));
  const storyboard={story_mode:'general',script:story.script,creative:story.creative,character_notes:'An atmospheric scene with no characters.',
    shots:story.script.map((s:any)=>({seg:s.id,visual:'Light over water',camera:'Wide shot',action:'The reflection moves',characters:[]}))};
  const settings=CreativeSettings.parse({engine:'lemo'});
  const creative={engine:'lemo',settings,selection:chooseStyle(story.creative,settings,story.script)};
  const seed=async(topic:string,status='queued',checkpoint:unknown=null)=>(await primary.query(`INSERT INTO drafts(topic,status,model,reasoning,story_mode,storyboard,creative,planner_checkpoint)
    VALUES($1,$2,'gpt-6.2-sol','high','general',$3,$4,$5) RETURNING id`,[topic,status,JSON.stringify(storyboard),JSON.stringify(creative),checkpoint?JSON.stringify(checkpoint):null])).rows[0].id as string;
  const a=await seed('fixture-A'),b=await seed('fixture-B'),ambiguous=await seed('fixture-unknown'),failed=await seed('fixture-failed');
  const wire:string[]=[];
  const posts=new Map<string,number>();
  let aStatus='queued', failedRead=false;
  const completed=(id:string)=>Response.json({id,status:'completed',usage:{input_tokens:20,output_tokens:8},output:[
    {type:'function_call',name:'submit_episode',call_id:'metadata_'+id,
      arguments:JSON.stringify({title_th:'เพลงของแสงบนผิวน้ำ',sources:[],claims:[],captions:{}})},
  ]});
  const mock:typeof fetch=async(url,init)=>{
    assert.equal(new URL(String(url)).hostname,'planner-fixture.invalid');
    if(init?.method==='POST'){
      const body=JSON.parse(String(init.body));
      const topic=body.input[0].content.match(/Topic from the owner: ([\w-]+)/)?.[1];
      assert.ok(topic);
      wire.push('POST '+topic);
      posts.set(topic,(posts.get(topic)||0)+1);
      assert.equal(posts.get(topic),1);
      assert.equal(body.background,true);
      if(topic==='fixture-unknown')throw TypeError('provider disconnected before response');
      if(topic==='fixture-A')return Response.json({id:'resp_pending',status:'queued'});
      if(topic==='fixture-failed')return Response.json({id:'resp_failed',status:'in_progress'});
      if(topic==='fixture-B')return completed('resp_new_draft');
      throw Error('unexpected create');
    }
    assert.equal(init?.method,'GET');
    const receipt=String(url).split('/').at(-1);
    wire.push('GET '+receipt);
    if(receipt==='resp_failed')return Response.json({id:receipt,status:'failed',error:{code:'content_policy'}});
    if(receipt==='resp_legacy')return completed(receipt);
    assert.equal(receipt,'resp_pending');
    if(failedRead)return new Response('<gateway>',{status:503});
    return aStatus==='completed'?completed(receipt):Response.json({id:receipt,status:aStatus});
  };
  const original=setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn:any,ms?:number,...args:any[])=>ms===8000?undefined:original(fn,ms,...args));
  const setup=(pool:pg.Pool)=>{
    const app=new Hono();
    const service=registerStudio(app,pool,{guard:async(_c,next)=>next(),plannerFetch:mock,
      createJob:async()=>{assert.fail('script review must precede production');},
      validate:()=>[],researchFreshness:()=>[],estimateCredits:()=>0});
    return {app,pump:service.pump};
  };
  const row=async(id:string)=>(await primary.query('SELECT status,error,planner_checkpoint,log,job_id,draft FROM drafts WHERE id=$1',[id])).rows[0];
  const read=async(service:ReturnType<typeof setup>,id:string)=>{
    const r=await service.app.request('/app/api/studio/drafts/'+id);assert.equal(r.status,200);return r.json();
  };
  const due=async(id:string)=>primary.query(`UPDATE drafts SET planner_checkpoint=jsonb_set(planner_checkpoint,'{wait,next_poll_at}','0') WHERE id=$1`,[id]);
  const first=setup(primary);
  const other=setup(replica);
  for(let n=0;n<200;n++){
    if((await row(b)).status==='ready'&&(await row(ambiguous)).status==='failed'&&(await row(failed)).planner_checkpoint?.wait)break;
    await new Promise(resolve=>original(resolve,20));
  }
  assert.equal((await row(b)).status,'ready');
  assert.equal((await row(a)).planner_checkpoint.calls.main.response_id,'resp_pending');
  assert.ok((await row(a)).planner_checkpoint.wait.next_poll_at>Date.now());
  assert.equal((await read(first,a)).planning.label,'รอคิว OpenAI');
  assert.equal((await read(first,ambiguous)).planning.phase,'uncertain');
  assert.equal((await read(first,ambiguous)).uncertain_planner_charge,true);
  assert.deepEqual(wire,['POST fixture-A','POST fixture-B','POST fixture-unknown','POST fixture-failed']);
  const old=(await row(a)).planner_checkpoint;
  old.calls={main:{response_id:'resp_legacy'}};
  delete old.wait;
  const legacy=await seed('fixture-legacy','writing',old);

  // Fresh registration rebuilds the planner from persisted state, rather than an in-memory continuation.
  const restarted=setup(replica);
  for(let n=0;n<100&&(await row(legacy)).status!=='ready';n++) {
    await Promise.all([restarted.pump(),other.pump()]);
    await new Promise(resolve=>original(resolve,10));
  }
  assert.equal((await row(legacy)).status,'ready');
  assert.ok(wire.includes('GET resp_legacy'));
  failedRead=true;
  await due(a);await due(failed);
  await restarted.pump();
  assert.equal((await row(a)).status,'researching');
  assert.equal((await read(restarted,a)).planning.phase,'retry_read');
  assert.equal((await row(failed)).status,'failed');
  assert.match((await row(failed)).error,/content_policy/);
  assert.equal((await read(restarted,failed)).planning.phase,'failed');

  failedRead=false;aStatus='in_progress';
  await due(a);await restarted.pump();
  assert.equal((await read(restarted,a)).planning.label,'OpenAI กำลังเขียน');
  aStatus='completed';
  await due(a);await Promise.all([first.pump(),restarted.pump()]);
  assert.equal((await row(a)).status,'ready');
  assert.equal((await row(a)).planner_checkpoint,null);
  assert.equal((await row(a)).job_id,null);
  assert.deepEqual([...posts.values()],[1,1,1,1]);
  assert.equal(wire.filter(m=>m==='GET resp_pending').length,3);
});
