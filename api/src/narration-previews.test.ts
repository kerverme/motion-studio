import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {canResumePreview,parseNarrationExample,registerNarrationPreviews} from './narration-previews.js';
process.env.OPENAI_API_KEY='mock-secret';
const db=new PGlite(),nativeFetch=globalThis.fetch;
const pool:any={query:(sql:string,args:any[]=[])=>db.query(sql,args)};
const calls:{method:string,body:any,url:string}[]=[];
let queued=false,fail=false,malformed=false,pollFailure=false,seq=0;
const example={text:'ลองนึกว่าร่างกายมีนาฬิกาเล็ก ๆ คอยบอกว่าเมื่อไรควรตื่นและเมื่อไรควรพัก นี่เป็นคำเปรียบเทียบเพื่อให้เห็นภาพ ไม่ใช่นาฬิกาจริงที่อยู่ในตัวเรา การนอนจึงมีทั้งเรื่องเวลาและความต้องการที่แตกต่างกันในแต่ละคน',notes:['ตัวอย่างนี้แสดงสไตล์การเล่า ยังไม่ได้ตรวจข้อกล่าวอ้างกับแหล่งต้นฉบับ']};
const response=(id='resp_test')=>({id,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(example)}]}]});
function server(){const app=new Hono();const service=registerNarrationPreviews(app,pool,{models:['gpt-6.1-sol','gpt-6.1-terra'],guard:async(c,next)=>c.req.header('authorization')==='Bearer owner'?next():c.json({error:'unauthorized'},401)});return {app,...service};}
const headers={authorization:'Bearer owner','content-type':'application/json'};
const post=(app:Hono,data:any)=>app.request('/app/api/studio/narration-previews',{method:'POST',headers,body:JSON.stringify(data)});
async function done(id:string){for(let i=0;i<600;i++){const row:any=(await db.query('SELECT * FROM narration_previews WHERE id=$1',[id])).rows[0];if(row&&['done','failed','paused'].includes(row.status))return row;await new Promise(r=>setTimeout(r,10));}throw new Error('preview timed out in test');}
before(async()=>{
 await db.exec('CREATE TABLE drafts(id uuid PRIMARY KEY); CREATE TABLE jobs(id uuid PRIMARY KEY);');
 await db.exec(readFileSync(new URL('../migrations/020_narration_previews.sql',import.meta.url),'utf8'));
 globalThis.fetch=async(url:any,init:any)=>{
  const method=init?.method||'GET',body=init?.body?JSON.parse(init.body):null;calls.push({method,body,url:String(url)});
  if(method==='POST'){
   if(fail)throw new TypeError('ambiguous disconnect mock-secret');
   const id='resp_preview'+(++seq);
   if(malformed)return Response.json({...response(id),output:[]});
   return Response.json(queued?{id,status:'queued'}:response(id));
  }
  if(pollFailure)return Response.json({error:{code:'upstream_unavailable'}},{status:503});
  return Response.json(response(String(url).split('/').pop()));
 };
});
after(async()=>{globalThis.fetch=nativeFetch;await db.close()});

test('preview requires complete structured Thai output; never substitutes a canned result',()=>{
 assert.deepEqual(parseNarrationExample(response()),example);
 assert.throws(()=>parseNarrationExample({...response(),status:'incomplete'}),/ไม่ครบ/);
 assert.throws(()=>parseNarrationExample({...response(),output:[]}));
 const english=response();english.output[0].content[0].text=JSON.stringify({...example,text:'Only English. '.repeat(10)});
 assert.throws(()=>parseNarrationExample(english),/ภาษาไทย/);
});

test('auth, input limits and custom style are validated before any paid call',async()=>{
 const {app}=server(),input={request_id:randomUUID(),topic:'การนอน'};const n=calls.length;
 assert.equal((await app.request('/app/api/studio/narration-previews',{method:'POST'})).status,401);
 for(const extra of [{request_id:'bad'},{model:'not-allowed'},{narration_style:'unknown'},{narration_style:'custom',narration_custom:' '},{narration_custom:'x'.repeat(1001)},{source_text:'x'.repeat(100001)},{topic:'',source_text:' '}])assert.equal((await post(app,{...input,...extra})).status,422);
 assert.equal(calls.length,n);
 assert.equal((await app.request('/app/api/studio/narration-previews/'+input.request_id,{headers})).status,404);
});

test('full 100k source, selected brain and style reach OpenAI without a production job',async()=>{
 const {app}=server(),id=randomUUID(),tail='END OF RESEARCH ไม่ตัดท้ายเอกสาร',full=' '.repeat(4)+'ข'.repeat(100000-4-tail.length)+tail;
 assert.equal(full.length,100000);
 const input={request_id:id,model:'gpt-6.1-terra',reasoning:'medium',story_mode:'general',topic:'นาฬิกาชีวิต',source_text:full,narration_style:'child_10'};
 assert.equal((await post(app,input)).status,202);const row=await done(id);assert.equal(row.status,'done');assert.equal(row.request.source_text,full);
 const req=calls.filter(x=>x.method==='POST').at(-1)!.body,user=JSON.parse(req.input[1].content),system=req.input[0].content;
 assert.equal(req.model,'gpt-6.1-terra');assert.equal(req.reasoning.effort,'medium');assert.equal(req.background,true);assert.equal(req.tools,undefined);assert.equal(user.source_text,full);
 assert.match(system,/10-year-old/);assert.match(system,/unverified secondary material/);assert.match(system,/dosages/);assert.match(system,/Never say you opened/);assert.match(system,/no research tools/);
 const result=await(await app.request('/app/api/studio/narration-previews/'+id,{headers})).json();assert.equal(result.source_characters,100000);assert.equal(result.model,input.model);assert.equal(result.narration_style,'child_10');assert.deepEqual(result.example,example);assert.equal('request' in result,false);
 for(const table of ['drafts','jobs'])assert.equal((await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
});

test('duplicate clicks and response-loss replay share one call; changed inputs need a new request',async()=>{
 const {app}=server(),input={request_id:randomUUID(),topic:'การนอน',narration_style:'custom',narration_custom:'เปรียบเหมือนช่างซ่อมนาฬิกา แต่บอกให้ชัดว่าเป็นอุปมา'};
 const n=calls.filter(x=>x.method==='POST').length;
 await Promise.all([post(app,input),post(app,input)]);await done(input.request_id);
 assert.equal((await post(server().app,input)).status,200);assert.equal(calls.filter(x=>x.method==='POST').length,n+1);
 assert.equal((await post(app,{...input,narration_custom:'สารคดีจริงจัง'})).status,409);
 assert.equal((await post(app,{...input,source_text:'อีกเอกสาร'})).status,409);
 const req=calls.filter(x=>x.method==='POST').at(-1)!.body;assert.ok(req.input[0].content.includes(input.narration_custom));assert.equal(req.model,'gpt-6.1-sol');
 const next={...input,request_id:randomUUID()};await post(app,next);await done(next.request_id);assert.equal(calls.filter(x=>x.method==='POST').length,n+2);
});

test('ambiguous disconnect and malformed output fail visibly without retrying creates or leaking data',async()=>{
 for(const type of ['disconnect','malformed']){
  const {app}=server(),input={request_id:randomUUID(),topic:'การนอน'};fail=type==='disconnect';malformed=type==='malformed';const n=calls.length;
  await post(app,input);const row=await done(input.request_id);fail=false;malformed=false;
  assert.equal(row.status,'failed');assert.equal(row.example,null);assert.ok(!row.error.includes('mock-secret'));assert.equal(calls.length,n+1);
  assert.equal((await post(app,input)).status,200);assert.equal(calls.length,n+1);
 }
});

test('background response ID is checkpointed and polled rather than reposted',async()=>{
 const {app}=server(),id=randomUUID();queued=true;await post(app,{request_id:id,topic:'การนอน'});
 let row:any;for(let i=0;i<100;i++){row=(await db.query('SELECT * FROM narration_previews WHERE id=$1',[id])).rows[0];if(row.response_id)break;await new Promise(r=>setTimeout(r,10));}
 assert.match(row.response_id,/^resp_/);assert.equal(row.status,'running');queued=false;assert.equal((await done(id)).status,'done');assert.ok(calls.some(c=>c.method==='GET'&&c.url.endsWith('/'+row.response_id)));
});

test('restart resumes known response reads and never resubmits ambiguous creates',async()=>{
 const known=randomUUID(),unknown=randomUUID(),request=JSON.stringify({model:'gpt-6.1-sol',topic:'การนอน',source_text:'',narration_style:'standard',narration_custom:''});
 await db.query("INSERT INTO narration_previews(id,request_hash,request,status,response_id) VALUES($1,'saved',$2,'running','resp_saved')",[known,request]);
 await db.query("INSERT INTO narration_previews(id,request_hash,request,status) VALUES($1,'unknown',$2,'running')",[unknown,request]);
 const n=calls.filter(x=>x.method==='POST').length;await server().start();
 assert.equal((await done(known)).status,'done');const lost=await done(unknown);assert.equal(lost.status,'failed');assert.match(lost.error,/ไม่ส่งซ้ำ/);assert.equal(calls.filter(x=>x.method==='POST').length,n);
});


test('ambiguous polling failures remain resumable by reading the saved response only',async()=>{
 assert.equal(canResumePreview('OpenAI ตรวจสถานะไม่สำเร็จ: NETWORK_ERROR [resp_saved]','resp_saved'),true);
 assert.equal(canResumePreview('OpenAI HTTP 503: unavailable [resp_saved]','resp_saved'),true);
 assert.equal(canResumePreview('OpenAI เกินเวลารอต่อรอบ — ยังยืนยันการยกเลิกไม่ได้','resp_saved'),true);
 assert.equal(canResumePreview('OpenAI เกินเวลารอต่อรอบ — ยกเลิกงานแล้ว','resp_saved'),false);
 assert.equal(canResumePreview('OpenAI ส่งคำขอไม่สำเร็จ: NETWORK_ERROR',null),false);
 const id=randomUUID(),request=JSON.stringify({model:'gpt-6.1-sol',topic:'การนอน',source_text:'',narration_style:'standard',narration_custom:''});
 await db.query("INSERT INTO narration_previews(id,request_hash,request,status,response_id,error) VALUES($1,'saved',$2,'paused','resp_saved','network error')",[id,request]);
 const {app}=server(),n=calls.filter(x=>x.method==='POST').length;
 const paused=await(await app.request('/app/api/studio/narration-previews/'+id,{headers})).json();assert.equal(paused.status,'paused');
 assert.equal((await app.request('/app/api/studio/narration-previews/'+id+'/resume',{method:'POST',headers})).status,200);
 assert.equal((await done(id)).status,'done');assert.equal(calls.filter(x=>x.method==='POST').length,n);
});


test('accepted paid create survives exhausted polling outage and explicit resume with exactly one POST',async()=>{
 const {app}=server(),id=randomUUID(),n=calls.filter(x=>x.method==='POST').length,nativeTimeout=globalThis.setTimeout;
 globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(fn,ms!==undefined&&ms>=2000?1:ms,...args)) as typeof setTimeout;
 queued=true;pollFailure=true;
 try{
  await post(app,{request_id:id,topic:'การนอน'});const paused=await done(id);
  assert.equal(paused.status,'paused');assert.match(paused.response_id,/^resp_/);assert.match(paused.error,/503/);
  pollFailure=false;queued=false;
  await app.request('/app/api/studio/narration-previews/'+id+'/resume',{method:'POST',headers});
  const completed=await done(id);assert.equal(completed.status,'done');assert.equal(completed.response_id,paused.response_id);
  assert.equal(calls.filter(x=>x.method==='POST').length,n+1);
 }finally{pollFailure=false;queued=false;globalThis.setTimeout=nativeTimeout;}
});
