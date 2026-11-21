import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {Hono} from 'hono';import {randomUUID} from 'node:crypto';import {readdirSync,readFileSync} from 'node:fs';
import {registerReverse} from './reverse.js';import {sha} from './reverse-contract.js';import {motionLock,promptText} from './reverse-prompts.js';import {sceneInputHash,sceneGate} from './scene-logic.js';import {generationSceneBinding,applySceneExport} from './scene-routes.js';import {compileExport} from './prompt-export.js';
const db=new PGlite(),query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};},pool={query,connect:async()=>({query,release(){}})},app=new Hono(),P='/app/api/reverse',headers={'x-owner':'test','content-type':'application/json'};let p:any,v:any,g:any,firstQuote:any;const request=(path:string,body?:any)=>app.request(P+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
registerReverse(app,pool as any,{guard:async(c,n)=>c.req.header('x-owner')==='test'?n():c.json({error:'unauthorized'},401),openaiModelCheck:async()=>{},prices:async()=>[{endpoint_id:'minimax/h3-max/text-to-video',unit:'seconds',unit_price:.0375,currency:'USD'}]});
const doc={duration_s:2,summary_th:'Synthetic fixture',characters:[{id:'C1',description:'woman in blue coat'},{id:'C2',description:'man in grey coat'}],locations:[{id:'L1',description:'narrow hallway'}],shots:[{id:'shot_001',start_s:0,end_s:2,location_id:'L1',opening:'[C1] walks toward [C2] in [L1].',actions:[{t0:0,t1:1,text:'[C1] collides with [C2].'},{t0:1,t1:2,text:'The wallet accidentally slips from [C1] and falls onto the floor.'}],ending:'The wallet lies on the floor.',camera:'Locked medium shot.',lighting:'Soft light.',style:'Live action.',props:'One wallet.'}],compatibility:['Walkable path'],uncertainty:[]};
const ev=(i:number,at:number)=>({frame_index:i,at_s:at,observation:'Synthetic observed frame.'});const graph={summary:'Collision causes accidental wallet drop',events:[{id:'E1',shot_id:'shot_001',start_s:0,end_s:1,actor_ids:['C1','C2'],object_ids:[],action:doc.shots[0].actions[0].text,mode:'collision',basis:'observed',source_action_indices:[0],evidence:[ev(0,0),ev(15,.5)],uncertainty:''},{id:'E2',shot_id:'shot_001',start_s:1,end_s:2,actor_ids:['C1'],object_ids:['O1'],action:doc.shots[0].actions[1].text,mode:'accidental',basis:'observed',source_action_indices:[1],evidence:[ev(30,1),ev(59,1.966667)],uncertainty:''}],dependencies:[{from:'E1',to:'E2',relation:'causes',basis:'observed',explanation:'Physical impact releases the wallet.'}],spatial:[],objects:[{id:'O1',description:'wallet',states:[]}],issues:[]};
before(async()=>{for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())await db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8').replace(/CREATE EXTENSION[^;]*;/g,''));const rate={model:'gpt-6.2-sol',currency:'USD',input_per_million:2,output_per_million:10,source:'https://developers.openai.com/api/docs/models/gpt-6.2-sol',checked_at:new Date().toISOString(),valid_until:new Date(Date.now()+86400000).toISOString()};process.env.MOTION_REVERSE_OPENAI_RATE_JSON=JSON.stringify(rate);await query("INSERT INTO integrations(provider,data) VALUES('reverse_worker',$1)",[JSON.stringify({openai:true,fal:true,guided_video:true,prompt_model:rate.model,prompt_rate:rate,scene_logic_version:'motion.scene-logic.v1',key_fingerprints:{openai:'test',fal:'test'}})]);p=await(await request('/projects',{origin_key:'scene-test',title:'Synthetic scene',source:{sha256:'a'.repeat(64),bytes:100,filename:'source.mp4',content_type:'video/mp4'}})).json();p.analysis={source:{width:1920,height:1080,end_s:2},shots:[{id:'shot_001',start_s:0,end_s:2}]};await query('UPDATE reverse_projects SET analysis=$2 WHERE id=$1',[p.id,JSON.stringify(p.analysis)]);const selection='s'.repeat(64),evidence={start_s:0,end_s:2,duration_s:2,shots:doc.shots,frames:[0,15,30,59].map((frame,i)=>({frame,at_s:[0,.5,1,1.966667][i],asset_id:randomUUID(),sha256:'f'.repeat(64)}))};await query('INSERT INTO reverse_prompt_selections(id,project_id,source_sha256,request,evidence) VALUES($1,$2,$3,$4,$5)',[selection,p.id,p.source_sha256,'{"start_s":0,"end_s":2}',JSON.stringify(evidence)]);v={id:sha(doc),project_id:p.id,selection_id:selection,document:doc,replacements:{characters:{C1:'adult young man in a navy jacket'},locations:{}},locks_hash:motionLock(doc),provenance:{}};await query('INSERT INTO reverse_prompt_versions(id,project_id,selection_id,document,replacements,prompt_a,prompt_b,locks_hash,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[v.id,p.id,selection,JSON.stringify(doc),JSON.stringify(v.replacements),promptText(doc),promptText(doc,v.replacements),v.locks_hash,'{}']);});
after(async()=>{delete process.env.MOTION_REVERSE_OPENAI_RATE_JSON;await db.close();});
test('director quote binds exact B, discloses image reasoning and submits nothing',async()=>{const r=await request('/projects/'+p.id+'/scene-logic-quote',{version_id:v.id,main_character_id:'C1'});assert.equal(r.status,200,await r.clone().text());firstQuote=await r.json();assert.equal(firstQuote.purpose,'scene_logic');const task=firstQuote.tasks[0];assert.equal(task.payload.max_output_tokens,32000);assert(task.payload.system.includes('compact strict graph JSON'));assert(task.usd>=32000*task.rate.output_per_million/1e6);assert.equal(task.payload.context.input_hash,sceneInputHash(v,'C1'));assert.equal(task.payload.context.replacements.characters.C1,v.replacements.characters.C1);assert.equal(task.payload.context.base_graph_id,null);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);assert.equal((await app.request(P+'/projects/'+p.id+'/scene-logic')).status,401);});
test('compiler preserves accident/collision causes and binds main-character choice',async()=>{g={id:sha(graph),project_id:p.id,version_id:v.id,source_sha256:p.source_sha256,locks_hash:v.locks_hash,input_hash:sceneInputHash(v,'C1'),graph,review:{},provenance:{main_character_id:'C1'}};await query('INSERT INTO reverse_scene_graphs(id,project_id,version_id,source_sha256,locks_hash,input_hash,graph,review,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[g.id,p.id,v.id,p.source_sha256,v.locks_hash,g.input_hash,JSON.stringify(graph),'{}',JSON.stringify(g.provenance)]);const exp=await(await request('/projects/'+p.id+'/prompt-export?'+new URLSearchParams({version_id:v.id,endpoint_id:'minimax/h3-max/text-to-video',main_character_id:'C1'}))).json();assert(exp.copy_allowed);assert(exp.prompt_b.includes('E1 causes E2'));assert(exp.prompt_b.includes('accidental'));assert.equal(exp.scene_logic.graph_id,g.id);const other=await(await request('/projects/'+p.id+'/scene-logic?'+new URLSearchParams({version_id:v.id,main_character_id:'C2'}))).json();assert.equal(other.graphs.length,0);assert.throws(()=>applySceneExport(compileExport(doc,v.replacements,'minimax/h3-max/text-to-video',p.analysis.source,undefined,'C2'),v,g,p.analysis.source,undefined,'C2'));});
test('range price, exact export, consent and Finish retrieval are independently bound',async()=>{
 const path='/projects/'+p.id;
 const original=sha({original:v.id}),newer=sha({newer:v.id});
 const addVersion=(id:string,replacements:any)=>query(`INSERT INTO reverse_prompt_versions(id,project_id,selection_id,document,replacements,prompt_a,prompt_b,locks_hash,provenance)
   SELECT $1,project_id,selection_id,document,$2,prompt_a,prompt_b,locks_hash,provenance FROM reverse_prompt_versions WHERE id=$3`,[id,JSON.stringify(replacements),v.id]);
 await addVersion(original,{characters:{},locations:{}});
 const wrong=await request(path+'/prompt-video-quote',{version_id:v.id,graph_id:'x'.repeat(64),variant:'b'});
 assert.equal(wrong.status,409);
 const status=await request(path+'/guided');assert.equal(status.status,200,await status.clone().text());assert.equal((await status.json()).end_s,2);
 const price=await (await request(path+'/prompt-video-price?version_id='+v.id)).json();
 assert.equal(price.estimate_usd,.16);assert.equal(price.usd,.24);
 const body={version_id:v.id,graph_id:g.id,main_character_id:'C1',variant:'b'};
 const quoteResponse=await request(path+'/prompt-video-quote',body);assert.equal(quoteResponse.status,200,await quoteResponse.clone().text());
 const q=await quoteResponse.json(),task=q.tasks[0];
 const exp=await(await request(path+'/prompt-export?'+new URLSearchParams({version_id:v.id,endpoint_id:task.endpoint,main_character_id:'C1'}))).json();
 assert.equal(task.payload.prompt,exp.prompt_b);assert.equal(q.scene_logic.payload_hash,sha(task.payload));
 assert.equal(task.estimate_usd,price.estimate_usd);assert.equal(task.payload.prompt_expansion_mode,'disabled');assert(!('image_url' in task.payload));
 assert.equal((await query("SELECT count(*)::int n FROM jobs WHERE package->'reverse'->>'action'='prompt_video'")).rows[0].n,0);
 const consent={quote_id:q.id,binding:q.binding,accepted_usd:q.total_usd,source_confirmed:true,rights_confirmed:true};
 await addVersion(newer,v.replacements);
 assert.equal((await request(path+'/approve',consent)).status,409);
 await query('DELETE FROM reverse_prompt_versions WHERE id=$1',[newer]);
 const missing=await request(path+'/approve',{...consent,rights_confirmed:false});assert.equal(missing.status,409);
 await query("UPDATE reverse_scene_graphs SET review=$2 WHERE id=$1",[g.id,JSON.stringify({reason:'new review'})]);
 assert.equal((await request(path+'/approve',consent)).status,409);
 await query("UPDATE reverse_scene_graphs SET review='{}' WHERE id=$1",[g.id]);
 const ok=await request(path+'/approve',consent);assert.equal(ok.status,202,await ok.clone().text());
 const first=await ok.json();assert.equal((await(await request(path+'/approve',consent)).json()).job_id,first.job_id);
 assert.equal((await query("SELECT count(*)::int n FROM jobs WHERE package->'reverse'->>'action'='prompt_video'")).rows[0].n,1);
 // A second tab can have a different valid quote for identical work.
 const other=await (await request(path+'/prompt-video-quote',body)).json();
 assert.notEqual(other.id,q.id);
 const approveOther=()=>request(path+'/approve',{...consent,quote_id:other.id,binding:other.binding});
 const duplicate=await approveOther();
 assert.equal(duplicate.status,200,await duplicate.clone().text());
 assert.deepEqual(await duplicate.json(),{job_id:first.job_id,status:'NEW',reused:true});
 const state=await(await request(path+'/progress?job_id='+first.job_id)).json();
 assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].version_id,v.id);assert.equal(state.jobs[0].variant,'b');
 assert.equal((await(await request('/production-jobs',{projects:[p.id]})).json()).jobs[0].id,first.job_id);
 assert.equal((await(await request('/production-jobs',{projects:[randomUUID()]})).json()).jobs.length,0);
 await query("UPDATE jobs SET status='FAILED',error='unknown request outcome' WHERE id=$1",[first.job_id]);
 assert.equal((await(await approveOther()).json()).job_id,first.job_id);
 assert.equal((await query("SELECT count(*)::int n FROM creative_approvals WHERE job_id=$1",[first.job_id])).rows[0].n,1);
 const credit={provider:'fal.ai',rejected_before_acceptance:true};
 await query("UPDATE jobs SET updated_at=now(),finished_at=now(),stage_results=jsonb_build_object('_reverse_credit',$2::jsonb) WHERE id=$1",[first.job_id,JSON.stringify(credit)]);
 assert.equal((await(await request(path+'/approve',consent)).json()).job_id,first.job_id);
 assert.equal((await(await approveOther()).json()).job_id,first.job_id);
 const fresh=await(await request(path+'/prompt-video-quote',body)).json();
 const replacement=await request(path+'/approve',{...consent,quote_id:fresh.id,binding:fresh.binding}),replacementJob=await replacement.json();
 assert.equal(replacement.status,202);assert.notEqual(replacementJob.job_id,first.job_id);
 for(const table of ['creative_approvals','reverse_approvals'])await query('DELETE FROM '+table+' WHERE job_id=$1',[replacementJob.job_id]);
 const asset=randomUUID();
 for(const [id,role] of [[asset,'finished_video'],[randomUUID(),'generated_raw']])await query("INSERT INTO reverse_assets(id,project_id,role,storage_key,sha256,bytes,content_type,encryption,metadata) VALUES($1,$2,$3,$4,$5,9,'video/mp4','{}',$6)",[id,p.id,role,id,'e'.repeat(64),JSON.stringify({variant:'b',version_id:v.id})]);
 assert.equal((await request('/projects/'+randomUUID()+'/assets/'+asset)).status,404);
 const library=await(await request('/finished',{projects:[p.id]})).json();assert.deepEqual(library.items.map((a:any)=>a.id),[asset]);
 assert.deepEqual((await(await request('/finished',{projects:[randomUUID()]})).json()).items,[]);
 // The remaining scene tests intentionally start from an empty ledger.
 await query('DELETE FROM creative_approvals WHERE job_id=$1',[first.job_id]);await query('DELETE FROM reverse_approvals WHERE job_id=$1',[first.job_id]);
});
test('new graph invalidates old director quote before approval/ledger reservation',async()=>{const r=await request('/projects/'+p.id+'/approve',{quote_id:firstQuote.id,binding:firstQuote.binding,accepted_usd:firstQuote.total_usd,source_confirmed:true,rights_confirmed:true});assert.equal(r.status,409);assert.equal((await query('SELECT count(*)::int n FROM reverse_approvals')).rows[0].n,0);});
test('observed critical issue blocks; explicit dismissal creates immutable child',async()=>{g.graph={...graph,issues:[{id:'I1',type:'cause_effect',severity:'critical',shot_id:'shot_001',event_ids:['E2'],evidence:[ev(30,1),ev(59,1.966667)],explanation:'Deliberate placement contradicts accidental fall.',suggested_correction:'Preserve accidental loss of grip.',confidence:.9,basis:'observed',uncertainty:''}]};await query('UPDATE reverse_scene_graphs SET graph=$2 WHERE id=$1',[g.id,JSON.stringify(g.graph)]);assert.equal(sceneGate(g).status,'blocked');const r=await request('/projects/'+p.id+'/scene-logic-review',{graph_id:g.id,confirmed_issue_ids:[],dismissed_issue_ids:['I1'],overrides:[],reason:'I reviewed the source frames.',approved:true});assert.equal(r.status,200,await r.clone().text());const child=await r.json();assert.notEqual(child.id,g.id);assert.equal(child.gate.status,'passed');assert.equal((await query('SELECT review FROM reverse_scene_graphs WHERE id=$1',[g.id])).rows[0].review.approved,undefined);g=child;});
test('creative override requires revalidation and cannot leak into original A',async()=>{const body={graph_id:g.id,confirmed_issue_ids:[],dismissed_issue_ids:['I1'],overrides:[{event_id:'E2',text:'[C1] deliberately places the wallet on the floor.',reason:'Approved alternative story.'}],reason:'I intentionally want a different causal meaning.',approved:true};const r=await request('/projects/'+p.id+'/scene-logic-review',body);assert.equal(r.status,200,await r.clone().text());const changed=await r.json();assert(changed.review.requires_revalidation);assert.equal(changed.gate.status,'blocked');const exp=applySceneExport(compileExport(doc,v.replacements,'minimax/h3-max/text-to-video',p.analysis.source,undefined,'C1'),v,changed,p.analysis.source,undefined,'C1');assert(!exp.copy_allowed);assert(!exp.prompt_a.includes('deliberately'));assert(exp.prompt_b.includes('USER-APPROVED'));assert.equal((await request('/projects/'+p.id+'/scene-logic-review',{...body,graph_id:changed.id,overrides:[]})).status,409);assert.deepEqual((await query('SELECT document FROM reverse_prompt_versions WHERE id=$1',[v.id])).rows[0].document,doc);});
test('generation rejects missing/stale graph and no regeneration is automatic',async()=>{await assert.rejects(generationSceneBinding(pool,p,{shots:[]},['shot_001']),/scene_graph_id/);await assert.rejects(generationSceneBinding(pool,p,{shots:[{shot_id:'shot_001',model:'h3_max',prompt:'place deliberately'}]},['shot_001'],g.id),/newer review/);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);});

test('single-shot compiler rebases graph time and labels cross-shot cause as outside context',()=>{
 const document={...doc,duration_s:10,shots:[doc.shots[0],{...doc.shots[0],id:'shot_002',start_s:8,end_s:10,actions:doc.shots[0].actions.map(a=>({...a,t0:a.t0+8,t1:a.t1+8}))}]};
 const version={...v,document};const report={...g,review:{},input_hash:sceneInputHash(version,'C1'),graph:{...graph,events:[{...graph.events[0],id:'E0'},...graph.events.map(e=>({...e,shot_id:'shot_002',start_s:e.start_s+8,end_s:e.end_s+8}))],dependencies:[...graph.dependencies,{from:'E0',to:'E1',relation:'before',basis:'observed',explanation:'Earlier shot establishes context.'}]}};
 const exported=applySceneExport({endpoint_id:'minimax/h3-max/text-to-video',prompt_a:'Original source prompt',prompt_b:'Remake prompt',warnings:[],blockers:[],copy_allowed:true},version,report,p.analysis.source,'shot_002','C1');
 assert.match(exported.prompt_a,/E1 \[shot_002\] 0–1s/);assert.match(exported.prompt_b,/E2 \[shot_002\] 1–2s/);assert(!exported.prompt_b.includes('8–9s'));assert.match(exported.prompt_b,/Context outside this shot, not an extra action to render: E0/);
});

test('model paraphrase and mode cannot replace accidental source actions in either prompt',()=>{
 const bad='[C1] deliberately places the wallet on the floor.';
 const report={...g,review:{},graph:{...graph,events:graph.events.map(e=>({...e,action:bad,mode:'deliberate'}))}};
 const exported=applySceneExport(compileExport(doc,v.replacements,'minimax/h3-max/text-to-video',p.analysis.source,undefined,'C1'),v,report,p.analysis.source,undefined,'C1');
 for(const prompt of [exported.prompt_a,exported.prompt_b]){
  assert(prompt.includes(doc.shots[0].actions[1].text));assert(!prompt.includes(bad));assert(!prompt.includes('deliberate'));
 }
 const shifted={...v,document:{...doc,duration_s:10,shots:[doc.shots[0],{...doc.shots[0],id:'shot_002',start_s:8,end_s:10}]}};
 const outside={...report,input_hash:sceneInputHash(shifted,'C1'),graph:{...report.graph,events:[{...report.graph.events[0],id:'E0'},...report.graph.events.map((e:any)=>({...e,shot_id:'shot_002',start_s:e.start_s+8,end_s:e.end_s+8}))],dependencies:[{from:'E0',to:'E1',relation:'before',basis:'observed',explanation:'Prior context.'}]}};
 const scoped=applySceneExport({endpoint_id:'minimax/h3-max/text-to-video',prompt_a:'A',prompt_b:'B',warnings:[],blockers:[]},shifted,outside,p.analysis.source,'shot_002','C1');
 assert.match(scoped.prompt_a,/Context outside this shot, not an extra action to render: E0: \[C1\] collides with \[C2\]/);assert(!scoped.prompt_a.includes(bad));
});

test('inspection prepares generated-only frames without charging and quotes bind exact output asset',async()=>{
 const fresh={...g,id:'f'.repeat(64),graph,review:{}};
 await query('INSERT INTO reverse_scene_graphs(id,project_id,version_id,source_sha256,locks_hash,input_hash,graph,review,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[fresh.id,p.id,v.id,p.source_sha256,v.locks_hash,fresh.input_hash,JSON.stringify(graph),'{}',JSON.stringify(g.provenance)]);
 const asset=randomUUID(),source=randomUUID(),legacy=randomUUID();
 for(const [id,role] of [[asset,'generated_candidate'],[source,'source']])await query('INSERT INTO reverse_assets(id,project_id,shot_id,role,storage_key,sha256,bytes,content_type,metadata) VALUES($1,$2,$3,$4,$5,$6,100,$7,$8)',[id,p.id,'shot_001',role,id,'e'.repeat(64),'video/mp4',JSON.stringify({graph_id:fresh.id,version_id:v.id,input_hash:fresh.input_hash,rights_confirmed:true})]);
 assert.equal((await request('/projects/'+p.id+'/inspection-prepare',{graph_id:fresh.id,asset_id:source})).status,409);
 await query('INSERT INTO reverse_assets(id,project_id,shot_id,role,storage_key,sha256,bytes,content_type,metadata) VALUES($1,$2,$3,$4,$5,$6,100,$7,$8)',[legacy,p.id,'shot_001','generated_shot',legacy,'d'.repeat(64),'video/mp4','{}']);
 const legacyResponse=await request('/projects/'+p.id+'/inspection-prepare',{graph_id:fresh.id,asset_id:legacy});assert.equal(legacyResponse.status,409);assert.match(await legacyResponse.text(),/no checked generation quote/);
 const r=await request('/projects/'+p.id+'/inspection-prepare',{graph_id:fresh.id,asset_id:asset});assert.equal(r.status,202,await r.clone().text());const ready=await r.json();assert.equal(ready.paid_requests,0);assert.equal((await query('SELECT package FROM jobs WHERE id=$1',[ready.job_id])).rows[0].package.reverse.action,'inspection_prepare');
 const params={graph_id:fresh.id,asset_id:asset};assert.equal((await request('/projects/'+p.id+'/inspection-quote',params)).status,409);
 await query('UPDATE reverse_inspection_evidence SET evidence=$2 WHERE id=$1',[ready.evidence_id,JSON.stringify({duration_s:2,inspected_shot_id:'shot_001',frames:[{frame:0,at_s:0,asset_id:randomUUID(),sha256:'1'.repeat(64)},{frame:59,at_s:1.966667,asset_id:randomUUID(),sha256:'2'.repeat(64)}]})]);
 const quoted=await request('/projects/'+p.id+'/inspection-quote',params);assert.equal(quoted.status,200,await quoted.clone().text());const q=await quoted.json();assert.equal(q.purpose,'video_inspection');assert.equal(q.tasks[0].payload.context.asset_sha256,'e'.repeat(64));assert.equal(q.tasks[0].payload.context.graph_id,fresh.id);assert.equal(q.tasks[0].payload.context.graph_hash,sha(graph));assert.equal((await query('SELECT count(*)::int n FROM reverse_approvals')).rows[0].n,0);
 await query('UPDATE reverse_assets SET sha256=$2 WHERE id=$1',[asset,'3'.repeat(64)]);assert.equal((await request('/projects/'+p.id+'/approve',{quote_id:q.id,binding:q.binding,accepted_usd:q.total_usd,source_confirmed:true,rights_confirmed:true})).status,409);assert.equal((await query('SELECT count(*)::int n FROM creative_calls')).rows[0].n,0);
});

test('saved-only spatial recovery keeps the job and approval, is idempotent and project scoped',async()=>{
 const j=randomUUID(),pkg={reverse:{project_id:p.id,action:'scene_logic',quote:{tasks:[{role:'scene_logic'}]}}};
 await query("INSERT INTO jobs(id,kind,status,package,package_sha256,idempotency_key,error) VALUES($1::uuid,'reverse','FAILED',$2,'hash',$1::uuid::text,'ValueError: Unknown spatial reference')",[j,JSON.stringify(pkg)]);
 const path='/projects/'+p.id+'/recover-scene';
 assert.equal((await request('/projects/'+randomUUID()+'/recover-scene',{job_id:j})).status,409);
 for(let i=0;i<2;i++){
   const res=await request(path,{job_id:j});assert.equal(res.status,202,await res.clone().text());
   assert.deepEqual(await res.json(),{job_id:j,status:'NEW',paid_requests:0});
 }
 const row=(await query('SELECT package,stage_results FROM jobs WHERE id=$1',[j])).rows[0];
 assert.deepEqual(row.package,pkg);assert.equal(row.stage_results._saved_scene_only,true);
 assert.equal((await query('SELECT count(*)::int n FROM creative_approvals WHERE job_id=$1',[j])).rows[0].n,0);
});

test('a verbose inspection fits the fal limit by indexing the complete immutable directions',()=>{
 const v1={...v,document:doc,replacements:{characters:{C1:'a new lead in a green coat'},locations:{L1:'a new station'}}};
 const raw=compileExport(doc,v1.replacements,'minimax/h3-max/text-to-video',p.analysis.source,undefined,'C1');
 const source=raw.locked_directions;
 const spatial={event_id:'E1',character_id:'C1',basis:'unknown',position:'near the doorway',orientation:'forward',
  gaze:'unclear',field_of_view:'unknown',distance:'near',visible_objects:[],occlusions:[],knowledge:'unverified',
  uncertainty:'unverified viewpoint '.repeat(240)};
 const noisy={...graph,spatial:Array.from({length:15},()=>spatial)};
 const reviewed={...g,review:{},input_hash:sceneInputHash(v1,'C1'),graph:noisy};
 const out=applySceneExport(raw,v1,reviewed,p.analysis.source,undefined,'C1');
 assert.equal(out.copy_allowed,true);assert.equal(out.scene_logic.indexed_source_actions,true);
 for(const prompt of [out.prompt_a,out.prompt_b]){
   assert(Array.from(prompt).length<=50000);assert(prompt.includes(source));
   assert(prompt.includes('E1 causes E2'));assert(prompt.includes('E2 = shot 1, action 2, 1–2s'));
   assert(prompt.includes('Unverified viewpoints: C1@E1'));assert(!prompt.includes(spatial.uncertainty));
 }
 assert(out.prompt_b.includes('a new lead in a green coat'));assert(!out.prompt_a.includes('a new lead in a green coat'));
 assert(out.prompt_b.includes('a new station'));
});
