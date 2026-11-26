import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Hono} from 'hono';
import {PGlite} from '@electric-sql/pglite';
import {CreativeSettings,chooseStyle} from './creative.js';

process.env.MOTION_LLM_PROVIDER='openai';
process.env.OPENAI_API_KEY='mock-only';
delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('../tests/studio-fixture.js');

test('saved Lemo plan rejects unavailable and malformed calls, then stops a repeating schema error before paying for another turn',async t=>{
  const db=new PGlite();
  const migrations=new URL('../migrations/',import.meta.url);
  for(const f of readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort()){
    await db.exec(readFileSync(new URL(f,migrations),'utf8'));
  }
  const query=async(sql:string,args:any[]=[])=>{
    const r=await db.query<any>(sql,args);
    return {...r,rowCount:r.affectedRows};
  };
  const story=JSON.parse(readFileSync(new URL('../../lemo-worker/tests/fixtures/dream.json',import.meta.url),'utf8'));
  const storyboard={story_mode:'general',script:story.script,creative:story.creative,character_notes:'An atmospheric scene with no characters.',shots:story.script.map((s:any)=>({
    seg:s.id,visual:'Light moves over the surface of the water.',camera:'Wide shot',action:'The reflection moves.',characters:[]}))};
  const settings=CreativeSettings.parse({engine:'lemo'});
  const selection=chooseStyle(story.creative,settings,story.script);
  const {id}=(await query("INSERT INTO drafts(topic,status,model,story_mode,storyboard,creative) VALUES($1,'queued','gpt-6.2-sol','general',$2,$3) RETURNING id",
    [story.topic,JSON.stringify(storyboard),JSON.stringify({engine:'lemo',settings,selection})])).rows[0];
  const outputs:string[]=[];
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit)=>{
    const body=JSON.parse(String(options.body));
    const last=body.input.filter((item:any)=>item.type==='function_call_output').at(-1);
    if(last)outputs.push(last.output);
    calls++;
    if(calls>5)throw Error('Unexpected extra provider request');
    const metadata={title_th:'ลองมองแสงที่เปลี่ยนไป '+calls,sources:[{url:'https://example.org/source',claim:'แสงสะท้อน',publisher:'Fixture',confidence:'high',published:123}],claims:[],captions:{}};
    const name=calls===1?'draw_scene':calls===2?'read_page':'submit_episode';
    const args=calls===2?'{':JSON.stringify(metadata);
    return Response.json({id:'resp_mock_'+calls,status:'completed',output:[
      {type:'function_call',call_id:'call_'+calls,name,arguments:args}],usage:{input_tokens:20,output_tokens:8}});
  });
  const timer=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn:any,ms?:number,...args:any[])=>ms===8000?undefined:timer(fn,ms,...args));
  try{
    registerStudio(new Hono(),{query} as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw Error('Unexpected production');},
      validate:()=>[],researchFreshness:()=>[],estimateCredits:()=>0});
    const deadline=Date.now()+10000;
    let saved;
    do{
      await new Promise(resolve=>timer(resolve,10));
      saved=(await query('SELECT * FROM drafts WHERE id=$1',[id])).rows[0];
    }while(saved.status!=='failed' && Date.now()<deadline);
    assert.equal(saved.status,'failed',String(saved.error));assert.equal(calls,5,saved.error);
    assert.match(outputs[0],/Tool unavailable/);assert.match(outputs[1],/valid JSON object/);
    assert.match(outputs[2],/sources\.0\.published: Expected string/);
    assert.match(saved.error,/submit_episode.*sources\.0\.published/);
    assert.match(saved.problems[0],/sources\.0\.published/);
    assert.equal(saved.usage.input_tokens,100);assert.equal(saved.usage.turns,5);
    assert.deepEqual(saved.storyboard,storyboard);assert.equal(saved.job_id,null);
  }finally{await db.close();}
});
