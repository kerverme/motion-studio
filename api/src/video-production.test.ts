import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import {randomUUID} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {registerTextVideo} from './text-video.js';
import {productionProviders,parseProductionInput,PREVIOUS_FRAME,bindSourceClip,type ProductionProviders} from './video-production.js';
import type {FalVideoModel} from './video-registry.js';

const db=new PGlite();let tail=Promise.resolve();
const query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
const pool={query,connect:async()=>{const prev=tail;let release!:()=>void;tail=new Promise(r=>release=r);await prev;return {query,release};}};
const headers={'content-type':'application/json','x-session':'ok'};
const path='/app/api/text-video/plans',internal='/internal/text-video/check-dispatch';
const plan={title:'จดหมายในขวด',synopsis:'เรื่องแต่งของขวดที่ลอยไปตามลำน้ำจนพบกับชายฝั่ง',kind:'fiction',visual_bible:'A green glass bottle, a quiet golden river and a consistent low horizon.',sources:[],story_bible:{characters:[],locations:[{id:'river',description:'Quiet golden river'}],props:[{id:'bottle',description:'Green empty bottle'}],visual_style:'Ink animation',lighting:'Morning sunlight',continuity_rules:['Keep the green bottle.']},shots:[4,7].map((seconds,i)=>({id:'shot_0'+(i+1),narration:i?'ขวดเดินทางต่อไปจนพบชายฝั่ง':'ขวดเริ่มล่องไปตามแม่น้ำ',visual_prompt:'A green bottle drifts across the water towards a quiet bank.',end_frame:'The green bottle drifts past the bank.',source_ids:[],direction:{scene_type:'landscape',purpose:'Show its journey.',subjects:['bottle'],setting:'river',camera:'Slow tracking shot',lighting:'Morning sunlight',actions:[{id:'float',actor:'bottle',action:'Float along the water.',after:[]}],opening_state:'The green bottle floats.',closing_state:'The green bottle floats past the bank.',duration_seconds:seconds,audio:'Quiet water lapping.'}}))};
const models=(['text-to-video','image-to-video'] as const).map((category,i):FalVideoModel=>({category,endpoint_id:'mock/example/'+category,name:'Example '+category,available:true,audio:true,resolutions:['720p','1080p'],durations:[4,8,12],schema_hash:'schema-'+i,price:{currency:'USD',unit:'seconds',unit_price:.1},input_schema:{type:'object',properties:{prompt:{type:'string'},duration:{type:'integer'},resolution:{type:'string'},aspect_ratio:{type:'string'},generate_audio:{type:'boolean'},...(i?{image_url:{type:'string'}}:{})},required:['prompt','duration','resolution']},source_url:'https://fal.ai/models/mock',checked_at:'2026-11-23'}));
const w={production_version:2,voice_models:['eleven_v3'],voice_model:'eleven_v3',voice_usd_per_1000_characters:.08,voice_id:'verified-voice',eleven:true,fal:true};
const send=(app:Hono,url:string,body:any,method='POST',more:Record<string,string>={})=>app.request(url,{method,headers:{...headers,'idempotency-key':randomUUID(),...more},body:JSON.stringify(body)});
let price=.1;let stale=false;let lookups=0;
const mock={...productionProviders,
  arena:async()=>({refreshing:false,categories:models.map((m,i)=>({category:m.category,stale,error:null,last_success_at:new Date().toISOString(),models:[{rank:i+1,name:m.name,fal:m}]}))}),
  model:async(id:string)=>{lookups++;return {...models.find(m=>m.endpoint_id===id)!,price:{unit:'seconds',unit_price:price,currency:'USD'}};},
  estimate:async(_m:FalVideoModel,payload:any)=>({usd:Math.round(price*payload.duration*1e4)/1e4,unit:'seconds',quantity:payload.duration}),
  direct:async(_db:any,ctx:any)=>{const c=ctx.candidates[0];return {endpoint_id:c.endpoint_id,model_name:c.name,rank:c.rank,selection_reason:'Verified cost and duration',knowledge_version:'mock-v1',inspection:{passed:true,issues:[],revisions:0},prompt:ctx.prompt_mode==='original'?ctx.original_prompt:'Directed '+ctx.scene.visual_prompt,generation_seconds:c.generation_seconds,edited_seconds:ctx.edited_seconds,knowledge_sources:[],prompt_format:'original'};},
} as unknown as ProductionProviders;
const app=new Hono();const service=registerTextVideo(app,pool as any,{autoStart:false,models:['gpt-6.2-sol'],guard:async(c,next)=>c.req.header('x-session')==='ok'?next():c.json({},401),workerGuard:async(c,next)=>c.req.header('x-internal-token')==='private-fixture'?next():c.json({},401),production:mock,response:async(body,opts)=>{const guides=JSON.parse(body.input[0].content).model_prompt_guides;assert.equal(guides[0].endpoint_id,models[0].endpoint_id);assert.equal(guides[0].knowledge_version,'first-guide');await opts.onProgress?.('Accepted [resp_mock_plan]');return {status:'completed',id:'resp_mock_plan',usage:{input_tokens:12,output_tokens:9},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]};}});
before(async()=>{process.env.OPENAI_API_KEY='fixture';process.env.FAL_KEY='fixture';const dir=new URL('../migrations/',import.meta.url);for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(file,dir),'utf8'));await query("INSERT INTO integrations(provider,data) VALUES ('text_video_worker',$1)",[JSON.stringify(w)]);
  await query("INSERT INTO video_arena_snapshots(category,models,last_success_at) VALUES('text-to-video',$1,now())",[JSON.stringify([{rank:1,fal:models[0]}])]);
  await query('INSERT INTO video_prompt_knowledge(endpoint_id,version,schema_hash,profile) VALUES($1,$2,$3,$4)',[models[0].endpoint_id,'first-guide',models[0].schema_hash,JSON.stringify({version:'first-guide',documents:[{tag:'guide_camera',text:'Use one camera motion to follow the subject.',source:models[0].source_url}]})]);});
after(()=>db.close());
async function newPlan() {const id=randomUUID();const creation=await send(app,path,{engine_version:2,topic:'นิทานจดหมายในขวด'},'POST',{'idempotency-key':id});assert.equal(creation.status,202,await creation.clone().text());await service.pump();const row=await (await app.request(path+'/'+id,{headers})).json();assert.equal(row.status,'ready',row.error);return row;}
const quote=(row:any)=>send(app,path+'/'+row.id+'/quote',{usd_to_thb:35,eleven_usd_per_1000_characters:.08});
const approve=(row:any,q:any)=>send(app,path+'/'+row.id+'/produce',{revision:row.revision,approved:true,confirmation:'CONFIRM '+q.id,quote_id:q.id});

test('planned media stays unpaid; price binding survives optimistic edits, concurrency and worker retries',async()=>{
  let row=await newPlan();const shots=row.plan.shots;assert.deepEqual(shots.map((s:any)=>[s.production.duration,s.production.edited_duration]),[[4,4],[8,7]]);assert.equal(row.request.resolution,'720p');assert.equal(row.request.routing_mode,'best_value');assert.equal(row.request.budget_usd,5);
  const [first,second]=shots;first.production.quantity=2;first.production.prompt_mode='manual';first.production.prompt='The green bottle bobs in the morning river.';second.production.audio=true;
  let r=await send(app,path+'/'+row.id,{revision:row.revision,plan:row.plan},'PATCH');assert.equal(r.status,200,await r.clone().text());row=await r.json();
  assert.equal((await send(app,path+'/'+row.id+'/quote',{usd_to_thb:35,eleven_usd_per_1000_characters:.00001})).status,422);
  r=await quote(row);assert.equal(r.status,200,await r.clone().text());let q=await r.json();assert.equal(q.scene_count,2);assert.equal(q.fal.length,3);assert.equal(q.fal[0].payload.prompt,first.production.prompt);assert.equal(q.fal[2].payload.image_url,PREVIOUS_FRAME);assert.equal(q.eleven.length,1);assert.equal(q.fal_usd,1.6);assert.equal(q.edited_seconds,11);assert.equal(q.generated_seconds,16);assert.ok(q.total_thb>=q.total_usd*35-.00001);assert.equal((await query('SELECT * FROM jobs')).rows.length,0);
  stale=true;assert.equal((await approve(row,q)).status,409);stale=false;price=.2;assert.equal((await approve(row,q)).status,409);price=.1;
  q=await(await quote(row)).json();const pair=await Promise.all([approve(row,q),approve(row,q)]);assert.deepEqual(pair.map(x=>x.status).sort(),[200,201]);const job=(await pair[0].json()).id;const pkg=(await query('SELECT package FROM jobs WHERE id=$1',[job])).rows[0].package;assert.equal(pkg.text_video.version,2);assert.deepEqual(pkg.storyboard.map((s:any)=>[s.start_s,s.end_s]),[[0,4],[4,11]]);
  const body={job_id:job,slot:'fal:shot_02'};assert.equal((await send(app,internal,body)).status,401);
  const validate=(slot=body.slot)=>send(app,internal,{...body,slot},'POST',{'x-internal-token':'private-fixture'});
  assert.equal((await validate()).status,200);price=.2;assert.equal((await validate()).status,409);price=.1;assert.equal((await validate('eleven:shot_02')).status,409);
  await query("INSERT INTO text_video_calls(job_id,slot,approval_id,provider,input_hash,status) VALUES($1,$2,$3,'fal','old-input','unknown')",[job,body.slot,q.id]);assert.equal((await validate()).status,409);await query("UPDATE jobs SET status='FAILED' WHERE id=$1",[job]);assert.equal((await quote(row)).status,422);
  await query("UPDATE text_video_calls SET status='done' WHERE job_id=$1",[job]);const repair=await quote(row);assert.equal(repair.status,200,await repair.clone().text());assert.ok(!(await repair.json()).pending_slots.includes(body.slot));assert.ok(lookups>1);
});

test('fallback resolution and total budget require a new signed estimate',async()=>{
  let row=await newPlan();row.plan.shots[0].production.resolution='1080p';let r=await send(app,path+'/'+row.id,{revision:row.revision,plan:row.plan},'PATCH');row=await r.json();assert.ok(row.plan.shots[0].production.issues.length);assert.equal((await quote(row)).status,422);
  row.plan.shots[0].production.approve_resolution=true;r=await send(app,path+'/'+row.id,{revision:row.revision,plan:row.plan,routing_mode:'within_budget',budget_usd:.2},'PATCH');row=await r.json();assert.equal((await quote(row)).status,422);
  assert.throws(()=>parseProductionInput({topic:'test',engine_version:2,manual_endpoint:'x',budget_usd:0}));
});
test('editing source is bound to exact bounded HTTPS media bytes',async()=>{
  const read=async()=>new Response('clip');assert.equal(await bindSourceClip('https://v3.fal.media/a.mp4',read),(await import('node:crypto')).createHash('sha256').update('clip').digest('hex'));
  await assert.rejects(bindSourceClip('https://badfal.media/a.mp4',read));await assert.rejects(bindSourceClip('https://fal.media/a',async()=>new Response('x',{headers:{'content-length':String(101*1024*1024)}})));
});

test('verified audio and sampled-frame inspection are itemized, price-bound, and native audio removes external sound calls',async()=>{
  const model='gpt-6.2-sol';const rate={model,currency:'USD',input_per_million:2,cache_write_per_million:2.5,output_per_million:10,source:'https://developers.openai.com/api/docs/models/'+model,checked_at:new Date().toISOString(),valid_until:new Date(Date.now()+3600_000).toISOString()};
  process.env.MOTION_REVERSE_OPENAI_RATE_JSON=JSON.stringify(rate);
  const audio={...w,sfx_models:['eleven_text_to_sound_v3'],sfx_credits_per_second:40,sfx_usd_per_second:.02,qa:true,qa_model:model,qa_rate:rate};
  const setWorker=(settings:any)=>query("UPDATE integrations SET data=$1,updated_at=now() WHERE provider='text_video_worker'",[JSON.stringify(settings)]);
  try {
    await setWorker(audio);let row=await newPlan();assert.equal(row.plan.shots[0].production.sfx.text,plan.shots[0].direction.audio);
    row.plan.shots[1].production.audio=true;const edit=await send(app,path+'/'+row.id,{revision:row.revision,plan:row.plan},'PATCH');row=await edit.json();const r=await quote(row);assert.equal(r.status,200,await r.clone().text());const q=await r.json();assert.equal(q.eleven.length,2);assert.equal(q.sfx_usd,.08);assert.equal(q.qa_usd,.16);assert.equal(q.pending_slots.filter((x:string)=>x.startsWith('qa:')).length,2);assert.equal(q.inspection.max_output_tokens,2000);
    const produced=await approve(row,q);assert.equal(produced.status,201,await produced.clone().text());const job=(await produced.json()).id;await query("UPDATE jobs SET status='QUALITY_CHECK' WHERE id=$1",[job]);const check=(slot:string)=>send(app,internal,{job_id:job,slot},'POST',{'x-internal-token':'private-fixture'});
    assert.equal((await check('qa:shot_01')).status,200);await setWorker({...audio,qa_rate:{...rate,input_per_million:99},sfx_usd_per_second:.09});assert.equal((await check('qa:shot_01')).status,409);assert.equal((await check('sfx:shot_01')).status,409);
  } finally {await setWorker(w);delete process.env.MOTION_REVERSE_OPENAI_RATE_JSON;}
});
