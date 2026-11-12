import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
process.env.MOTION_UI_PASSWORD='test-password';
const {registerUi}=await import('./ui.js');
const db=new PGlite(),pool:any={query:(sql:string,args:any[]=[])=>db.query(sql,args)};
const app=new Hono();registerUi(app,pool,{API_TOKEN:'owner',retryJob:async()=>({ok:true})});
const headers={authorization:'Bearer owner'};
let episodeNumber=100;
before(async()=>{const dir=new URL('../migrations/',import.meta.url);for(const name of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,dir),'utf8'));});
after(()=>db.close());
async function episode(title='ชื่อเรื่องเดิม',status='ready'){
 const id=randomUUID();await db.query('INSERT INTO episodes(id,number,topic,title_th,ui_status) VALUES($1,$2,$3,$3,$4)',[id,episodeNumber++,title,status]);return id;
}
async function draft(model:string|null,episodeId:string|null=null,jobId:string|null=null){
 const id=randomUUID();await db.query("INSERT INTO drafts(id,topic,status,model,episode_id,job_id) VALUES($1,'หัวข้อ','submitted',$2,$3,$4)",[id,model,episodeId,jobId]);return id;
}
async function job(episodeId:string,key:string|null){
 const id=randomUUID(),captions={facebook:'ข้อความโพสต์จริง',tiktok:'คำบรรยายเดิม'};
 await db.query("INSERT INTO jobs(id,episode_id,status,idempotency_key,package) VALUES($1,$2,'READY_TO_POST',$3,$4)",[id,episodeId,key,JSON.stringify({captions,voice:{model_id:'eleven_v4'},model:'not-a-brain-source'})]);return id;
}
async function handoff(episodeId:string,jobId:string|null){await db.query('INSERT INTO publication_handoffs(episode_id,job_id,folder_id,files) VALUES($1,$2,$3,$4)',[episodeId,jobId,'folder',JSON.stringify([{name:'video.mp4',url:'https://media.cloudbath.co/'+episodeId+'.mp4'}])]);}
async function list(tab='ready'){const r=await app.request('/app/api/episodes?tab='+tab,{headers});assert.equal(r.status,200);return(await r.json()).episodes;}

test('creator model comes from the immutable source draft, never a later deduplicated draft or audio setting',async()=>{
 const id=await episode('เทียบ Terra — ชื่อเดิมต้องไม่เปลี่ยน'),original=await draft('gpt-6.1-sol'),jobId=await job(id,'draft:'+original);
 await db.query('UPDATE drafts SET job_id=$2,episode_id=$3 WHERE id=$1',[original,jobId,id]);
 await draft('gpt-6.1-terra',id,jobId);await draft('gpt-6-astra',id,jobId);
 await handoff(id,jobId);await handoff(id,jobId);
 const found=(await list()).filter((e:any)=>e.id===id);assert.equal(found.length,1);assert.equal(found[0].generation_model,'gpt-6.1-sol');
 assert.equal(found[0].title,'เทียบ Terra — ชื่อเดิมต้องไม่เปลี่ยน');assert.equal(found[0].captions.facebook,'ข้อความโพสต์จริง');assert.equal(found[0].captions.tiktok,'คำบรรยายเดิม');
 const stored:any=(await db.query('SELECT title_th FROM episodes WHERE id=$1',[id])).rows[0];assert.equal(stored.title_th,found[0].title);
});

test('latest delivered handoff selects its own creator and the same model is available on used clips',async()=>{
 const id=await episode('คลิปที่เรนเดอร์ใหม่','used'),first=await draft('gpt-6.1-sol'),second=await draft('gpt-6-astra');
 await handoff(id,await job(id,'draft:'+first));await handoff(id,await job(id,'draft:'+second));
 const found=(await list('used')).filter((e:any)=>e.id===id);assert.equal(found.length,1);assert.equal(found[0].generation_model,'gpt-6-astra');
});

test('manual, missing, null or malformed provenance remains unknown without guessing from titles or linked drafts',async()=>{
 for(const key of [null,'manual-run','draft:not-a-uuid','draft:'+randomUUID()]){
  const id=await episode('[GPT-6 Astra] ชื่อที่ตั้งเอง'),jobId=await job(id,key);await draft('gpt-6.1-terra',id,jobId);await handoff(id,jobId);
  assert.equal((await list()).find((e:any)=>e.id===id).generation_model,null);
 }
 const id=await episode(),source=await draft(null);await handoff(id,await job(id,'draft:'+source));
 assert.equal((await list()).find((e:any)=>e.id===id).generation_model,null);
 const noJob=await episode();await handoff(noJob,null);assert.equal((await list()).find((e:any)=>e.id===noJob).generation_model,null);
});


test('chat-import authors are never presented as verified model provenance, even when they look like model IDs',async()=>{
 for(const author of ['Codex','gpt-6-astra','claude-chat']){
  const id=await episode(),source=await draft(author);
  await db.query('UPDATE drafts SET log=$2 WHERE id=$1',[source,JSON.stringify([{at:new Date().toISOString(),msg:'นำเข้าร่างที่เขียนในแชท (ค้นข้อมูลด้วย Firecrawl แล้ว)'}])]);
  await handoff(id,await job(id,'draft:'+source));assert.equal((await list()).find((e:any)=>e.id===id).generation_model,null);
 }
 const id=await episode(),source=await draft('claude-chat');await handoff(id,await job(id,'draft:'+source));
 assert.equal((await list()).find((e:any)=>e.id===id).generation_model,null);
 const future=await episode(),futureSource=await draft('gpt-future-version');await handoff(future,await job(future,'draft:'+futureSource));
 assert.equal((await list()).find((e:any)=>e.id===future).generation_model,'gpt-future-version');
});

test('Text to Video remains visible while producing or failed, with its plan and model for safe repair',async()=>{
 const id=await episode(),jobId=await job(id,'text-video:working-test'),planId=randomUUID();
 await db.query("UPDATE jobs SET kind='text_video',status='RENDERING',package=$2 WHERE id=$1",[jobId,JSON.stringify({generation_model:'gpt-6.1-sol',text_video:{plan_id:planId}})]);
 for(const status of ['RENDERING','FAILED']){
  await db.query('UPDATE jobs SET status=$2 WHERE id=$1',[jobId,status]);
  const r=await app.request('/app/api/working',{headers});assert.equal(r.status,200);
  const found=(await r.json()).jobs.find((j:any)=>j.id===jobId);
  assert.equal(found.status,status);assert.equal(found.kind,'text_video');assert.equal(found.text_video_plan_id,planId);assert.equal(found.draft_model,'gpt-6.1-sol');
  const clips=await(await app.request('/app/api/episodes?tab=ready',{headers})).json();assert.ok(clips.counts.working>=1);
 }
 await db.query("UPDATE jobs SET status='READY_TO_POST' WHERE id=$1",[jobId]);
 assert.ok(!(await(await app.request('/app/api/working',{headers})).json()).jobs.some((j:any)=>j.id===jobId));
});
