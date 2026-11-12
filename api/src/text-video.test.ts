import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {registerTextVideo} from './text-video.js';
import {parseVideoInput,validateVideoPlan,makeVideoQuote,digest,VIDEO_MODELS} from './text-video-contract.js';

process.env.OPENAI_API_KEY='test-only';process.env.FAL_KEY='test-only';
const db=new PGlite();let locked=Promise.resolve();
const query=async(sql:string,args:any[]=[])=>{const r=await db.query<any>(sql,args);return{...r,rowCount:r.affectedRows??r.rows.length};};
const pool={query,connect:async()=>{const prev=locked;let release!:()=>void;locked=new Promise(r=>release=r);await prev;return{query,release};}};
const input=parseVideoInput({topic:'นิทานเรือลำน้อย',model:'gpt-6.1-sol',duration:60});
const plan=(n=4)=>({title:'เรือลำน้อยเดินทางกลับบ้าน',synopsis:'นิทานสมมติเรื่องเรือลำน้อยที่ตามแสงกลับบ้าน',kind:'fiction',visual_bible:'A warm storybook paper boat with a red sail, golden light, calm river, consistent watercolor style.',sources:[],shots:Array.from({length:n},(_,i)=>({id:`shot_${String(i+1).padStart(2,'0')}`,narration:'เรือลำน้อยค่อยค่อยลอยไปตามลำน้ำ มองหาแสงไฟเพื่อกลับบ้าน',visual_prompt:'The same small paper boat with a red sail drifts toward a lantern beside the river, slow tracking camera.',end_frame:'The red sail boat rests on the lower left beside a warm lantern.',source_ids:[]}))});
const rates=VIDEO_MODELS.flatMap(m=>[m.t2v,m.i2v].map(endpoint_id=>({endpoint_id,unit:'seconds',unit_price:m.baseline,currency:'USD'})));
const path='/app/api/text-video/plans';let llmCalls=0,invalidSource=false,failResponse=false;
function server(){const app=new Hono();const service=registerTextVideo(app,pool as any,{autoStart:false,models:['gpt-6.1-sol','gpt-6.1-terra','gpt-6-astra'],guard:async(c,next)=>c.req.header('x-test-auth')==='yes'?next():c.json({error:'unauthorized'},401),prices:async()=>rates,response:async(body,opts)=>{
  llmCalls++;assert.equal(body.model,input.model);assert.equal(body.max_tool_calls,4);assert.match(body.instructions,/complete supplied source/);assert.equal(body.text,undefined,'hosted search must not request legacy JSON mode');await opts.onProgress?.('OpenAI accepted [resp_test123]');if(failResponse)throw new Error('OpenAI ตรวจสถานะไม่สำเร็จ [resp_test123]');
  const p:any=plan(JSON.parse(body.input[0].content).duration/15);if(invalidSource){p.kind='educational';p.sources=[{url:'https://invented.example/source',title:'Fake',publisher:'Fake',published:'unknown',claim:'unsupported'}];p.shots[0].source_ids=[0];}
  return {status:'completed',id:'resp_test123',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(p)}]}]};}});return{app,service};}
const headers={'content-type':'application/json','x-test-auth':'yes'};
const send=(app:Hono,url:string,body:any,method='POST',id=randomUUID())=>app.request(url,{method,headers:{...headers,'idempotency-key':id},body:JSON.stringify(body)});
async function ready(app:Hono,service:any){const id=randomUUID();const r=await send(app,path,input,'POST',id);assert.equal(r.status,202,await r.clone().text());await service.pump();return(await(await app.request(path+'/'+id,{headers})).json());}
before(async()=>{const dir=new URL('../migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(f,dir),'utf8'));await db.query("INSERT INTO integrations(provider,data) VALUES('text_video_worker',$1)",[JSON.stringify({version:1,fal:true,eleven:true,voice_id:'test-voice'})]);});
after(()=>db.close());

test('60/90/120 seconds are exactly 4/6/8 shots with resolution-aware, conservative separate prices',()=>{
  for(const duration of [60,90,120]){const x=parseVideoInput({...input,duration});const p=validateVideoPlan(plan(duration/15),x);const q=makeVideoQuote(x,p,randomUUID(),'voice',.3,[],rates);assert.equal(q.fal.length,duration/15);assert.equal(q.eleven.length,duration/15);assert.equal(q.fal_usd,duration/15*16*.08);assert.ok(q.eleven_usd>0);assert.equal(q.plan_hash,digest({input:x,plan:p}));}
  const x=parseVideoInput({...input,video_model:'grok_15',resolution:'720p'}),p=validateVideoPlan(plan(),x),q=makeVideoQuote(x,p,randomUUID(),'voice',0,[],rates);assert.equal(q.fal_usd,8.43,'base $0.01/sec must not underquote 720p $0.14/sec plus references');assert.equal(q.eleven_usd,0);assert.ok(q.eleven_credits>0);
  assert.throws(()=>parseVideoInput({...input,duration:150}));assert.throws(()=>parseVideoInput({...input,resolution:'4K'}));assert.throws(()=>validateVideoPlan(plan(5),input));
});

test('draft creation is authenticated, idempotent and cannot enqueue any paid media',async()=>{
  const {app,service}=server(),id=randomUUID(),count=llmCalls;assert.equal((await app.request(path,{method:'POST',body:'{}'})).status,401);
  await Promise.all([send(app,path,input,'POST',id),send(app,path,input,'POST',id)]);await service.pump();assert.equal(llmCalls,count+1);
  assert.equal((await send(server().app,path,input,'POST',id)).status,200);assert.equal((await send(app,path,{...input,topic:'อีกเรื่อง'},'POST',id)).status,409);
  assert.equal((await query('SELECT * FROM jobs')).rows.length,0);assert.equal((await query('SELECT * FROM text_video_calls')).rows.length,0);
  assert.equal((await send(app,path+'/'+id+'/produce',{})).status,409);
});

test('OpenAI evidence cannot be fabricated and saved response IDs survive failures',async()=>{
  const {app,service}=server();invalidSource=true;const bad=await ready(app,service);invalidSource=false;assert.equal(bad.status,'failed');assert.match(bad.error,/หลักฐาน/);
  failResponse=true;const paused=await ready(app,service);failResponse=false;assert.equal(paused.status,'failed');assert.equal((await query('SELECT response_id FROM text_video_plans WHERE id=$1',[paused.id])).rows[0].response_id,'resp_test123');
  assert.equal((await send(app,path+'/'+paused.id+'/resume',{})).status,200);await service.pump();assert.equal((await query('SELECT status FROM text_video_plans WHERE id=$1',[paused.id])).rows[0].status,'ready');
});

test('edited, expired or mismatched quotes cannot start production; duplicate approval produces one job',async()=>{
  const {app,service}=server();let p=await ready(app,service);assert.equal(p.status,'ready');
  let r=await send(app,path+'/'+p.id+'/quote',{eleven_usd_per_1000_credits:.3});assert.equal(r.status,200,await r.clone().text());let q=await r.json();
  const approval=(quote:any,rev:string)=>({quote_id:quote.id,revision:rev,approved:true,confirmation:'CONFIRM '+quote.id});
  assert.equal((await send(app,path+'/'+p.id+'/produce',{...approval(q,p.revision),approved:false})).status,409);
  r=await send(app,path+'/'+p.id,{revision:p.revision,plan:{...p.plan,title:'ชื่อใหม่'}},'PATCH');assert.equal(r.status,200,await r.clone().text());p=await r.json();
  assert.equal((await send(app,path+'/'+p.id+'/produce',approval(q,p.revision))).status,409);
  q=await(await send(app,path+'/'+p.id+'/quote',{eleven_usd_per_1000_credits:.3})).json();
  await query("UPDATE text_video_plans SET quote=jsonb_set(quote,'{expires_at}','\"2000-01-01T00:00:00Z\"') WHERE id=$1",[p.id]);assert.equal((await send(app,path+'/'+p.id+'/produce',approval(q,p.revision))).status,409);
  q=await(await send(app,path+'/'+p.id+'/quote',{eleven_usd_per_1000_credits:.3})).json();const responses=await Promise.all([send(app,path+'/'+p.id+'/produce',approval(q,p.revision)),send(app,path+'/'+p.id+'/produce',approval(q,p.revision))]);
  assert.deepEqual(responses.map(r=>r.status),[201,200]);const bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(bodies[0].id,bodies[1].id);
  const jobs=(await query('SELECT * FROM jobs')).rows;assert.equal(jobs.length,1);const job:any=jobs[0];assert.equal(job.kind,'text_video');assert.equal(job.package.generation_model,'gpt-6.1-sol');assert.equal(job.package.text_video.approval.id,q.id);assert.equal(job.package.music,null);assert.equal((await query('SELECT * FROM publish_log')).rows.length,0);
  assert.equal((await send(app,path+'/'+p.id,{revision:p.revision,plan:p.plan},'PATCH')).status,409);
});

test('repair quotes charge only missing calls and stop when a paid POST has unknown outcome',()=>{
  const p=validateVideoPlan(plan(),input);const calls=[{slot:'fal:shot_01',status:'done'},{slot:'fal:shot_02',status:'accepted'},{slot:'eleven:shot_01',status:'done'}];
  const q=makeVideoQuote(input,p,randomUUID(),'voice',.3,calls,rates);assert.equal(q.fal.length,2);assert.equal(q.eleven.length,3);
  assert.throws(()=>makeVideoQuote(input,p,randomUUID(),'voice',.3,[...calls,{slot:'fal:shot_03',status:'unknown'}],rates),/ยังไม่ทราบผล/);
  assert.throws(()=>makeVideoQuote(input,p,randomUUID(),'voice',.3,[],rates.map(r=>({...r,unit:'1000 tokens'}))),/หน่วยราคา/);
});

test('provider readiness and user ElevenLabs rate are required; no assumed free unknown costs',async()=>{
  const {app,service}=server(),p=await ready(app,service);assert.equal((await send(app,path+'/'+p.id+'/quote',{})).status,422);
  delete process.env.FAL_KEY;assert.equal((await send(app,path+'/'+p.id+'/quote',{eleven_usd_per_1000_credits:.3})).status,503);process.env.FAL_KEY='test-only';
  await query("UPDATE integrations SET updated_at=now()-interval '5 minutes' WHERE provider='text_video_worker'");assert.equal((await send(app,path+'/'+p.id+'/quote',{eleven_usd_per_1000_credits:.3})).status,503);
});
