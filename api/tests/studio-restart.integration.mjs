// Run from a non-root account with PostgreSQL binaries on PATH (or set PG_BIN):
// node api/tests/studio-restart.integration.mjs
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const apiDir=fileURLToPath(new URL('../',import.meta.url));
const tmp=mkdtempSync(join(tmpdir(),'motion-restart-'));
const pgData=join(tmp,'pg');
const pgTool=(name,args)=>execFileSync(process.env.PG_BIN?join(process.env.PG_BIN,name):name,args,{stdio:'pipe'});
const model='gpt-6.2-sol', source='https://example.org/fictional-cat-story';
const story=JSON.parse(readFileSync(new URL('../../lemo-worker/tests/fixtures/cats.json',import.meta.url),'utf8'));
const board={
  script:story.script,creative:story.creative,character_notes:'A fictional orange cat with a consistent face and scarf.',
  narrative:{premise:'The cats can talk for one day.',central_question:'How does a cat spend the day?',throughline:'An orange cat asks for fish and convenes a meeting.',payoff:'The cats return to meowing.'},
  sound_policy:{mode:'designed'},
  shots:story.script.map(s=>({seg:s.id,visual:'The orange cat looks at the dinner plate in the kitchen.',action:'The cat gestures at the fish with its paw.',camera:'A medium shot with a gentle push.',characters:['แมวส้ม'],
    subjects:[{id:'cat',description:'The same orange cat acting out this part of the narration.'}],
    continuity:{from:'Continue the same character action and its cause.',to:'The character prepares the following story action.'},
    motion_beats:[{start:0,end:.5,action:'The cat gestures toward the dinner plate.',purpose:'Illustrate the request from the narration.'},{start:.5,end:1,action:'The cat turns its face toward the door.',purpose:'Prepare the following story action.'}]}))
};
const metadata={title_th:story.topic,angle:'เรื่องสมมติเมื่อแมวพูดได้',sources:[],claims:[{text:'เรื่องนี้เป็นเหตุการณ์สมมติ',kind:'assumption',source_ids:[]}],captions:Object.fromEntries(['facebook','instagram','tiktok','youtube','twitter'].map(k=>[k,story.topic]))};
const use=(name,input)=>[{type:'function_call',name,id:'fc_'+name,call_id:'call_'+name,arguments:JSON.stringify(input)}];
const results={
  research:use('read_page',{url:source,use_firecrawl:false}),
  nested:[{type:'web_search_call',status:'completed',action:{type:'open_page',url:source}},{type:'message',content:[{type:'output_text',text:'A verified fictional scenario for use in this story.'}]}],
  plan:use('plan_story',board),submit:use('submit_episode',metadata)
};
const posts=[],gets=[],released=new Set(),errors=[];
let ambiguous=false, pgStarted=false;
const pending=new Map();
const processes=new Set();

function response(stage) {
  const waiting=['research','nested','submit'].includes(stage)&&!released.has(stage);
  return {id:'resp_'+stage,status:waiting?'in_progress':'completed',created_at:Math.floor(Date.now()/1000),usage:{input_tokens:100,output_tokens:10},output:waiting?[]:results[stage]};
}
function reply(res,status,obj) {
  res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(obj));
}
const provider=createServer(async(req,res)=>{
  try {
    if(req.url==='/v1/models')return reply(res,200,{data:[{id:model}]});
    if(req.url.startsWith('/v1/responses/resp_')&&req.method==='GET'){
      const stage=req.url.split('resp_')[1];gets.push(stage);return reply(res,200,response(stage));
    }
    assert.equal(req.method,'POST');assert.equal(req.url,'/v1/responses');
    let data='';for await(const chunk of req)data+=chunk;
    const body=JSON.parse(data);
    const outputs=body.input.filter(x=>x.type==='function_call_output');
    const stage=ambiguous?'ambiguous':body.tool_choice?.type==='web_search'?'nested':
      outputs.some(x=>x.call_id==='call_plan_story')?'submit':
      outputs.some(x=>x.call_id==='call_read_page')?'plan':'research';
    posts.push(stage);
    if(stage==='ambiguous'){pending.set(stage,res);return;}
    if(stage==='plan')assert.match(outputs.find(x=>x.call_id==='call_read_page').output,/verified fictional/i);
    return reply(res,200,response(stage));
  } catch(e){errors.push(String(e));reply(res,400,{error:{code:'invalid_fixture_request'}});}
});
async function port(server) {
  server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;
}
async function freePort(){const s=createServer();const n=await port(s);await new Promise(r=>s.close(r));return n;}
async function wait(message,fn,ms=40000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(await fn())return;await delay(80);}
  throw Error('Timed out: '+message);
}
let pgUrl,providerUrl;
async function start(){
  const n=await freePort();
  const child=spawn(process.execPath,['--import',join(tmp,'local-only.mjs'),'--import','tsx','src/index.ts'],{
    cwd:apiDir,env:{PATH:process.env.PATH,HOME:tmp,PORT:String(n),HOST:'127.0.0.1',DATABASE_URL:pgUrl,
      OPENAI_API_KEY:'local-test',OPENAI_BASE_URL:providerUrl,MOTION_LLM_PROVIDER:'openai',
      MOTION_UI_PASSWORD:'local-test',MOTION_API_TOKEN:'local-test',LEMO_DEVELOPMENT:'true'},
    stdio:['ignore','pipe','pipe']
  });
  const replica={child,base:'http://127.0.0.1:'+n,log:''};
  for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{replica.log=(replica.log+c.toString()).slice(-15000);});
  processes.add(replica);
  await wait('healthy API',async()=>{
    assert.equal(child.exitCode,null,replica.log);
    return fetch(replica.base+'/health').then(r=>r.ok).catch(()=>false);
  });
  return replica;
}
async function stop(replica){
  if(replica.child.exitCode===null&&replica.child.signalCode===null){
    const exited=once(replica.child,'exit');replica.child.kill('SIGKILL');await exited;
  }
  processes.delete(replica);
}
async function api(replica,path,body){
  const r=await fetch(replica.base+'/app/api/studio/drafts'+path,{method:body?'POST':'GET',
    headers:{authorization:'Bearer local-test','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;
}
function create(replica){return api(replica,'',{topic:story.topic,story_mode:'general',creative:{engine:'lemo'},presenter_kind:'context',recurring_character:false,auto_produce:false,model});}
async function takeover(stage,oldReplica){
  const count=()=>gets.filter(s=>s===stage).length;
  await wait('original owner polling '+stage,()=>count()>0);
  const next=await start();
  const original=posts.length;
  assert.equal(posts.filter(s=>s===stage).length,1);
  await stop(oldReplica);
  const before=count();
  await wait('new owner reads accepted '+stage,()=>count()>before);
  assert.equal(posts.length,original,'a takeover must use GET before continuing');
  released.add(stage);
  return next;
}
try{
  const p=await freePort();
  pgTool('initdb',['-D',pgData,'-U','qa','-A','trust','--no-locale','--encoding=UTF8','--no-sync']);
  pgTool('pg_ctl',['-D',pgData,'-l',join(tmp,'postgres.log'),'-o','-k '+tmp+' -h 127.0.0.1 -p '+p,'-w','start']);pgStarted=true;
  pgUrl='postgresql://qa@127.0.0.1:'+p+'/postgres';
  providerUrl='http://127.0.0.1:'+await port(provider);
  writeFileSync(join(tmp,'local-only.mjs'),`const real=globalThis.fetch;
    globalThis.fetch=(url,...args)=>new URL(url instanceof Request?url.url:url).origin===${JSON.stringify(providerUrl)}
      ?real(url,...args):Promise.reject(Error('External requests are disabled in integration tests'));`);
  let replica=await start();
  const {id}=await create(replica);
  replica=await takeover('research',replica);
  replica=await takeover('nested',replica);
  await wait('saved storyboard with outstanding final answer',()=>gets.includes('submit'));
  const writing=await api(replica,'/'+id);
  assert.equal(writing.status,'writing');assert.equal(writing.storyboard.shots.length,story.script.length);
  assert.equal(Object.hasOwn(writing,'planner_checkpoint'),false);
  replica=await takeover('submit',replica);
  let draft;
  await wait('ready draft',async()=>{
    draft=await api(replica,'/'+id);assert.notEqual(draft.status,'failed',JSON.stringify({error:draft.error,problems:draft.problems,log:draft.log?.slice(-4)}));return draft.status==='ready';
  });
  assert.deepEqual(posts,['research','nested','plan','submit']);assert.equal(draft.job_id,null);
  assert.equal(draft.usage.turns,3);assert.equal(draft.usage.input_tokens,400);
  assert.equal(draft.research.filter(e=>e.results?.some(s=>s.url===source)).length,1);
  assert.equal(draft.draft.title_th,story.topic);assert.deepEqual(errors,[]);
  console.log('PASS 3 SIGKILLs during accepted main, nested search and final writing: same draft ready; one POST per call, each takeover polled the original response, storyboard retained, source and usage recorded once.');
  ambiguous=true;
  const held=await create(replica);
  await wait('simulated provider accepted POST and its response ID is still unavailable',()=>pending.has('ambiguous'));
  await stop(replica);
  replica=await start();
  await wait('actionable held draft after ambiguous dispatch',async()=>{
    draft=await api(replica,'/'+held.id);return draft.status==='failed'&&!!draft.error;
  });
  assert.equal(posts.filter(k=>k==='ambiguous').length,1);
  assert.equal(draft.job_id,null);assert.deepEqual(errors,[]);
  console.log('PASS SIGKILL before receipt persistence: missing response ID halted the draft without a duplicate POST.');
}catch(e){for(const replica of processes)console.error(replica.log.slice(-2500));console.error(e);process.exitCode=1;}
finally{
  for(const replica of processes)await stop(replica);
  provider.closeAllConnections();if(provider.listening)await new Promise(r=>provider.close(r));
  if(pgStarted)pgTool('pg_ctl',['-D',pgData,'-m','immediate','-w','stop']);
  rmSync(tmp,{recursive:true,force:true});
}
