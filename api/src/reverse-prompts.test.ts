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
const doc={duration_s:2,summary_th:'Synthetic contract fixture',characters:[{id:'C1',description:'small red robot'}],locations:[{id:'L1',description:'quiet green room'}],shots:[{id:'shot_001',start_s:0,end_s:2,location_id:'L1',opening:'[C1] stands left inside [L1].',actions:[{t0:0,t1:2,text:'[C1] raises its right arm.'}],ending:'[C1] holds its right arm up.',camera:'Locked medium shot.',lighting:'Soft side light.',style:'3D animation.',props:'None.'}],compatibility:['The new character needs a right arm.'],uncertainty:['Synthetic test fixture.']};
before(async()=>{for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));process.env.MOTION_REVERSE_OPENAI_RATE_JSON=JSON.stringify(rate);
 await query("INSERT INTO integrations(provider,data) VALUES('reverse_worker',$1)",[JSON.stringify({openai:true,prompt_model:rate.model,prompt_rate:rate,key_fingerprints:{openai:'test-key'}})]);
 project=await(await request('/projects',{origin_key:'prompt-test',title:'Synthetic fixture',source:{sha256:'a'.repeat(64),bytes:100,filename:'reference.mp4',content_type:'video/mp4'}})).json();await query('UPDATE reverse_projects SET analysis=$2 WHERE id=$1',[project.id,JSON.stringify({source:{end_s:20},shots:[{id:'shot_001',start_s:0,end_s:20}]})]);});
after(async()=>{delete process.env.MOTION_REVERSE_OPENAI_RATE_JSON;await db.close();});
test('range bounded; source immutable; preparation idempotent without providers',async()=>{
 for(const range of [{start_s:0,end_s:16},{start_s:19,end_s:21}])assert.equal((await request('/projects/'+project.id+'/prompt-range',range)).status,409);
 const r=await request('/projects/'+project.id+'/prompt-range',{start_s:0,end_s:15});assert.equal(r.status,202);const a=await r.json();selection=a.selection_id;
 const b=await(await request('/projects/'+project.id+'/prompt-range',{start_s:0,end_s:15})).json();assert.equal(a.job_id,b.job_id);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);
});
test('OpenAI quote + duplicate approval reuse financial ledger; stale price blocks',async()=>{
 await query('UPDATE reverse_prompt_selections SET evidence=$2 WHERE id=$1',[selection,JSON.stringify({duration_s:15,start_s:0,end_s:15,frames:[{asset_id:randomUUID(),sha256:'f'.repeat(64),at_s:0}],shots:[]})]);
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
