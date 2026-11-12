import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {CreativeSettings,chooseStyle,estimateCreative,hash,releaseGates,creativePrompt} from './creative.js';
import {registerCreative} from './creative-routes.js';
const fixtures=['nik','dream','cats'].map(k=>JSON.parse(readFileSync(new URL(`../../lemo-worker/tests/fixtures/${k}.json`,import.meta.url),'utf8')));
test('three mocked semantic analyses rank deterministically and reject unknown styles',()=>{
  for(const [i,story] of fixtures.entries()){
    const settings=CreativeSettings.parse({engine:'lemo'}),selection=chooseStyle(story.creative,settings,story.script);
    assert.equal(selection.selected.id,['dataviz','firefly-pointillism','rubber-hose'][i]);
    const shuffled={...story.creative,candidates:[...story.creative.candidates].reverse()};assert.equal(chooseStyle(shuffled,settings,story.script).selected.id,selection.selected.id);
    const bad=structuredClone(story.creative);bad.candidates[0].id='made-up-style';assert.throws(()=>chooseStyle(bad,settings,story.script),/Unknown/);
    assert.match(creativePrompt(settings),/SAME planning call/);
  }
});
test('sound plans require real anchors; cache changes with story/settings and unknown cost stays unknown',()=>{
  const story=fixtures[0],settings=CreativeSettings.parse({}),choice=chooseStyle(story.creative,settings,story.script);
  const changed=chooseStyle(story.creative,{...settings,brand:'Other brand'},story.script);assert.notEqual(choice.cache_key,changed.cache_key);
  const bad=structuredClone(story.creative);bad.scenes[0].sound.cues[0].word='not in Thai narration';assert.throws(()=>chooseStyle(bad,settings,story.script),/anchor/);
  const q=estimateCreative({creative:{engine:'lemo'},draft:{},storyboard:{}},{script:story.script,sfx:[{duration:1}]});assert.deepEqual(q.unknown,['coding','narration','sfx','compute']);
  assert.equal(releaseGates({LEMO_ENABLED:'true'}).enabled,false);
});
const db=new PGlite();let locked=Promise.resolve();
const query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
const pool={query,connect:async()=>{const prev=locked;let release!:()=>void;locked=new Promise(r=>release=r);await prev;return {query,release};}};
before(async()=>{for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));});
after(()=>db.close());
test('approval is revision-bound, gated, budgeted and duplicate-safe under concurrent clicks',async()=>{
  const story=fixtures[0],settings=CreativeSettings.parse({engine:'lemo'}),selection=chooseStyle(story.creative,settings,story.script);
  const creative={engine:'lemo',settings,selection};
  const id=(await query("INSERT INTO drafts(topic,status,draft,storyboard,creative) VALUES($1,'ready',$2,$3,$4) RETURNING id",[story.topic,JSON.stringify({title_th:story.topic}),JSON.stringify({script:story.script,creative:story.creative}),JSON.stringify(creative)])).rows[0].id;
  const app=new Hono();registerCreative(app,pool as any,{guard:async(c,n)=>c.req.header('x-owner')==='yes'?n():c.json({},401),prepare:r=>({title_th:r.topic,script:story.script,storyboard:[],sfx:[{duration:.5}],sources:[],voice:{voice_id:'configured-voice'}})});
  const req=(path:string,body?:any)=>app.request('/app/api/creative/'+path,{method:body?'POST':'GET',headers:{'x-owner':'yes','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const quote=await(await req(id+'/estimate')).json() as any;
  const approve={revision:quote.revision,quote_hash:quote.quote_hash,max_usd:10,allocations:{coding:4,narration:2,sfx:1,compute:1},unknown_ack:true,style_ack:true};
  assert.equal((await req(id+'/approve',approve)).status,409,'license/security gates must block');
  const env={...process.env};for(const gate of releaseGates().blockers)process.env[gate]='true';process.env.LEMO_ENABLED='true';
  try{
    assert.equal((await req(id+'/approve',{...approve,unknown_ack:false})).status,409);
    assert.equal((await req(id+'/approve',{...approve,allocations:{coding:20}})).status,409);
    assert.equal((await req(id+'/approve',{...approve,revision:'old'})).status,409);
    const result=await Promise.all([req(id+'/approve',approve),req(id+'/approve',approve)]);assert.deepEqual(result.map(r=>r.status).sort(),[200,201]);
    assert.equal((await query("SELECT count(*)::int AS n FROM jobs WHERE kind='lemo'")).rows[0].n,1);
    const job=(await result[0].json() as any).id;
    assert.equal((await req('jobs/'+job+'/cancel',{})).status,200);
    assert.equal((await query('SELECT status FROM jobs WHERE id=$1',[job])).rows[0].status,'CANCELLED');
    assert.equal((await req('jobs/'+job+'/retry',{})).status,409);
    assert.equal((await app.request('/app/api/creative/'+id+'/estimate')).status,401);
  }finally{process.env=env;}
});
