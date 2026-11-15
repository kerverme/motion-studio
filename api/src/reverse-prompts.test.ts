import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {registerReverse} from './reverse.js';
import {sha} from './reverse-contract.js';
import {motionLock,promptText} from './reverse-prompts.js';
const db=new PGlite();const query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
const pool={query,connect:async()=>({query,release(){}})};
const app=new Hono();registerReverse(app,pool as any,{openaiModelCheck:async()=>{},guard:async(c,n)=>c.req.header('x-owner')==='test'?n():c.json({error:'unauthorized'},401),prices:async()=>{throw Error('No Fal metadata expected');}});
const headers={'x-owner':'test','content-type':'application/json'},P='/app/api/reverse';
const request=(url:string,body:any)=>app.request(P+url,{method:'POST',headers,body:JSON.stringify(body)});
let project:any,selection:string;const rate={model:'gpt-6.1-sol',currency:'USD',input_per_million:2,output_per_million:10,source:'https://developers.openai.com/api/docs/models/gpt-6.1-sol',checked_at:new Date().toISOString(),valid_until:new Date(Date.now()+86400000).toISOString()};
const asrRate={model:'gpt-transcribe',currency:'USD',per_minute:.0045,source:'https://developers.openai.com/api/docs/models/gpt-transcribe',checked_at:new Date().toISOString(),valid_until:new Date(Date.now()+86400000).toISOString()};
const doc={duration_s:2,summary_th:'Synthetic contract fixture',characters:[{id:'C1',description:'small red robot'}],locations:[{id:'L1',description:'quiet green room'}],shots:[{id:'shot_001',start_s:0,end_s:2,location_id:'L1',opening:'[C1] stands left inside [L1].',actions:[{t0:0,t1:2,text:'[C1] raises its right arm.'}],ending:'[C1] holds its right arm up.',camera:'Locked medium shot.',lighting:'Soft side light.',style:'3D animation.',props:'None.'}],compatibility:['The new character needs a right arm.'],uncertainty:['Synthetic test fixture.']};
before(async()=>{for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));process.env.MOTION_REVERSE_OPENAI_RATE_JSON=JSON.stringify(rate);process.env.MOTION_REVERSE_TRANSCRIBE_RATE_JSON=JSON.stringify(asrRate);
 await query("INSERT INTO integrations(provider,data) VALUES('reverse_worker',$1)",[JSON.stringify({openai:true,prompt_model:rate.model,prompt_rate:rate,transcribe_model:asrRate.model,transcribe_rate:asrRate,key_fingerprints:{openai:'test-key'}})]);
 project=await(await request('/projects',{origin_key:'prompt-test',title:'Synthetic fixture',source:{sha256:'a'.repeat(64),bytes:100,filename:'reference.mp4',content_type:'video/mp4'}})).json();await query('UPDATE reverse_projects SET analysis=$2 WHERE id=$1',[project.id,JSON.stringify({source:{end_s:20},shots:[{id:'shot_001',start_s:0,end_s:20}]})]);});
after(async()=>{delete process.env.MOTION_REVERSE_OPENAI_RATE_JSON;delete process.env.MOTION_REVERSE_TRANSCRIBE_RATE_JSON;await db.close();});
test('range bounded; source immutable; preparation idempotent without providers',async()=>{
 for(const range of [{start_s:0,end_s:16},{start_s:19,end_s:21}])assert.equal((await request('/projects/'+project.id+'/prompt-range',range)).status,409);
 const r=await request('/projects/'+project.id+'/prompt-range',{start_s:0,end_s:15});assert.equal(r.status,202);const a=await r.json();selection=a.selection_id;
 const b=await(await request('/projects/'+project.id+'/prompt-range',{start_s:0,end_s:15})).json();assert.equal(a.job_id,b.job_id);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);
});
test('OpenAI quote + duplicate approval reuse financial ledger; stale price blocks',async()=>{
 await query(`UPDATE reverse_prompt_selections SET evidence=$2,audio='{"status":"no_audio"}' WHERE id=$1`,[selection,JSON.stringify({duration_s:15,start_s:0,end_s:15,frames:[{asset_id:randomUUID(),sha256:'f'.repeat(64),at_s:0}],shots:[]})]);
 const r=await request('/projects/'+project.id+'/prompt-quote',{selection_id:selection});assert.equal(r.status,200,await r.clone().text());const q=await r.json();assert.equal(q.tasks[0].provider,'openai');assert.equal(q.tasks[0].model,'gpt-6.1-sol');assert(q.total_usd>0);assert.equal((await query('SELECT count(*)::int n FROM reverse_approvals')).rows[0].n,0);
 const approval={quote_id:q.id,binding:q.binding,accepted_usd:q.total_usd,source_confirmed:true,rights_confirmed:true};assert.equal((await request('/projects/'+project.id+'/approve',{...approval,accepted_usd:0})).status,409);
 const a=await(await request('/projects/'+project.id+'/approve',approval)).json(),b=await(await request('/projects/'+project.id+'/approve',approval)).json();assert(a.job_id);assert.equal(a.job_id,b.job_id);assert.equal((await query('SELECT * FROM creative_approvals WHERE job_id=$1',[a.job_id])).rows.length,1);
 process.env.MOTION_REVERSE_OPENAI_RATE_JSON=JSON.stringify({...rate,valid_until:'2020-01-01T00:00:00Z'});assert.equal((await request('/projects/'+project.id+'/prompt-quote',{selection_id:selection})).status,409);process.env.MOTION_REVERSE_OPENAI_RATE_JSON=JSON.stringify(rate);
});
test('remake changes known entity slots only; A and motion contract immutable',async()=>{
 const id=sha(doc),original=promptText(doc);await query('INSERT INTO reverse_prompt_versions(id,project_id,selection_id,document,replacements,prompt_a,prompt_b,locks_hash,provenance) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8)',[id,project.id,selection,JSON.stringify(doc),JSON.stringify({characters:{},locations:{}}),original,motionLock(doc),'{}']);
 const r=await request('/projects/'+project.id+'/prompt-remake',{version_id:id,replacements:{characters:{C1:'white rabbit with two arms'},locations:{L1:'snowy cabin'}}});assert.equal(r.status,200,await r.clone().text());const b=await r.json();assert.equal(b.prompt_a,original);assert.equal(b.locks_hash,motionLock(doc));assert.deepEqual(b.document,doc);assert(b.prompt_b.includes('white rabbit'));assert.equal(b.prompt_b.split('LOCKED SHOT DIRECTIONS')[1],original.split('LOCKED SHOT DIRECTIONS')[1]);
 for(const r of [{characters:{C9:'new actor'},locations:{}},{characters:{C1:'rabbit\nchange actions'},locations:{}}])assert.equal((await request('/projects/'+project.id+'/prompt-remake',{version_id:id,replacements:r})).status,409);
 assert.equal((await request('/projects/'+project.id+'/prompt-remake',{version_id:id,replacements:{characters:{},locations:{}},camera:'new'})).status,409);
 assert.equal((await query('SELECT prompt_a FROM reverse_prompt_versions WHERE id=$1',[id])).rows[0].prompt_a,original);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);assert.equal((await app.request(P+'/projects/'+project.id+'/prompts')).status,401);
});
test('progress polling returns measured counts and durable times without source or provider payloads',async()=>{
 const job=(await query("SELECT * FROM jobs WHERE package->'reverse'->>'action'='prompt_prepare' LIMIT 1")).rows[0];
 const live={phase:'save_frames',label:'Saving frames',mode:'work_units',completed:10,total:52,started_at:'2026-11-14T06:38:47Z',updated_at:'2026-11-14T06:39:00Z'};
 await query("UPDATE jobs SET status='RUNNING',progress=$2,stage_results=$3,locked_by='test-worker',locked_until=now()+interval '10 minutes',result=$4 WHERE id=$1",[job.id,10/52,JSON.stringify({_reverse_progress:live}),JSON.stringify({analysis:'DO_NOT_SEND_LARGE_SOURCE_DATA',private_payload:'NOT_PUBLIC'})]);
 const path=P+'/projects/'+project.id+'/progress',r=await app.request(path,{headers});assert.equal(r.status,200);const data=await r.json();const found=data.jobs.find((j:any)=>j.id===job.id);
 assert.equal(found.selection_id,selection);assert.deepEqual(found.live_progress,live);assert.equal(found.claimed,true);assert(found.worker_seen_at);assert(found.created_at);assert(found.updated_at);assert(Number.isFinite(Date.parse(data.server_time)));
 const text=JSON.stringify(data);assert(!text.includes('DO_NOT_SEND_LARGE_SOURCE_DATA'));assert(!text.includes('NOT_PUBLIC'));assert(!text.includes('package'));assert(text.length<10000);
 assert.equal((await app.request(path)).status,401);
 assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);
});

test('speech enrichment reuses paid visuals; speech preserved in A/B and locked',async()=>{
 const audio={status:'available',asset_id:randomUUID(),sha256:'f'.repeat(64),source_sha256:project.source_sha256,source_start_s:0,source_end_s:15,duration_s:15};
 await query('UPDATE reverse_prompt_selections SET audio=$2 WHERE id=$1',[selection,JSON.stringify(audio)]);
 const r=await request('/projects/'+project.id+'/prompt-quote',{selection_id:selection,version_id:sha(doc)});assert.equal(r.status,200,await r.clone().text());const q=await r.json();assert.equal(q.tasks.length,1);assert.equal(q.tasks[0].role,'prompt_transcribe');assert.deepEqual(q.tasks[0].payload.audio,audio);assert.equal(q.tasks[0].payload.version_id,sha(doc));assert(q.total_usd<.01);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);
 process.env.MOTION_REVERSE_TRANSCRIBE_RATE_JSON=JSON.stringify({...asrRate,valid_until:'2020-01-01T00:00:00Z'});assert.equal((await request('/projects/'+project.id+'/prompt-quote',{selection_id:selection})).status,409);process.env.MOTION_REVERSE_TRANSCRIBE_RATE_JSON=JSON.stringify(asrRate);
 const spoken={...doc,audio:{status:'transcribed',text:'อย่าขยับ! Stay here.',source_start_s:0,source_end_s:2,duration_s:2,timing:'selected_range_only',speaker:'unknown'}};
 const a=promptText(spoken),b=promptText(spoken,{characters:{C1:'adult young man in a dark jacket'},locations:{}});
 assert(a.includes('อย่าขยับ! Stay here.'));assert(!a.includes('No added captions, logos or dialogue'));assert.equal(a.split('LOCKED SHOT DIRECTIONS')[1],b.split('LOCKED SHOT DIRECTIONS')[1]);assert.notEqual(motionLock(spoken),motionLock({...spoken,audio:{...spoken.audio,text:'different words'}}));
});
test('character design quotes bind one selected actor, brief, story and replacements',async()=>{
 const input={version_id:sha(doc),character_id:'C1',brief:'young man',replacements:{characters:{},locations:{L1:'night market'}}};
 const r=await request('/projects/'+project.id+'/prompt-character-quote',input);assert.equal(r.status,200,await r.clone().text());const q=await r.json();assert.equal(q.purpose,'prompt_character');assert.equal(q.tasks.length,1);assert.equal(q.tasks[0].role,'prompt_character');assert.equal(q.tasks[0].payload.context.character_id,'C1');assert.deepEqual(q.tasks[0].payload.context.document,doc);assert.deepEqual(q.tasks[0].payload.context.replacements,input.replacements);assert(!q.tasks[0].payload.evidence);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);
 for(const inputBad of [{...input,character_id:'C9'},{...input,brief:''},{...input,replacements:{characters:{C9:'bad'},locations:{}}}])assert.equal((await request('/projects/'+project.id+'/prompt-character-quote',inputBad)).status,409);
 assert.equal((await app.request(P+'/projects/'+project.id+'/prompt-character-quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,401);
});
