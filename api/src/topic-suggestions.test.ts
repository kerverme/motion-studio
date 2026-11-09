import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {parseTopicIdeas,registerTopicSuggestions} from './topic-suggestions.js';
process.env.OPENAI_API_KEY='mock-secret';
const db=new PGlite();const nativeFetch=globalThis.fetch;
const pool:any={query:(sql:string,args:any[]=[])=>db.query(sql,args)};
const calls:{method:string,body:any,url:string}[]=[];
let queued=false,fail=false,seq=0;
const batches=new Map<string,string[]>();
const ideas=(suffix='')=>['ทำไมแก้วน้ำเย็นจึงมีหยดน้ำด้านนอก','ถ้าไฟจราจรหายไป เมืองจะเปลี่ยนอย่างไร','สิ่งของใกล้ตัวเดินทางมาจากไหน','ทำไมใบไม้มีรูปทรงต่างกัน','เรารู้เวลาได้อย่างไรก่อนมีนาฬิกา'].map(x=>x+suffix);
const response=(list:string[],id='resp_test')=>({id,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({ideas:list})}]}]});
function server(){const app=new Hono();const service=registerTopicSuggestions(app,pool,{models:['gpt-6.1-sol','gpt-6.1-terra'],guard:async(c,next)=>c.req.header('authorization')==='Bearer owner'?next():c.json({error:'unauthorized'},401)});return {app,...service};}
const headers={authorization:'Bearer owner','content-type':'application/json'};
const post=(app:Hono,data:any)=>app.request('/app/api/studio/topic-suggestions',{method:'POST',headers,body:JSON.stringify(data)});
async function done(id:string){for(let i=0;i<600;i++){const row:any=(await db.query('SELECT * FROM topic_suggestions WHERE id=$1',[id])).rows[0];if(row&&['done','failed'].includes(row.status))return row;await new Promise(r=>setTimeout(r,10));}throw new Error('suggestion timed out in test');}
before(async()=>{
 await db.exec("CREATE TABLE drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),topic text,draft jsonb,created_at timestamptz DEFAULT now());");
 await db.exec(readFileSync(new URL('../migrations/018_topic_suggestions.sql',import.meta.url),'utf8'));
 globalThis.fetch=async(url:any,init:any)=>{
  const method=init?.method||'GET',body=init?.body?JSON.parse(init.body):null;calls.push({method,body,url:String(url)});
  if(method==='POST'){
   if(fail)throw new TypeError('ambiguous disconnect');
   const id='resp_suggest'+(++seq);const list=ideas(' ชุด'+seq);batches.set(id,list);
   return Response.json(queued?{id,status:'queued'}:response(list,id));
  }
  const id=String(url).split('/').pop()!;return Response.json(response(batches.get(id)||ideas(),id));
 };
});
after(async()=>{globalThis.fetch=nativeFetch;await db.close()});

test('ideas filter repeated suggestions, require Thai and refuse malformed/incomplete output',()=>{
 assert.equal(parseTopicIdeas(response(ideas()),[ideas()[0]]).length,4);
 assert.throws(()=>parseTopicIdeas(response(Array(5).fill(ideas()[0])),[]),/ซ้ำ/);
 assert.throws(()=>parseTopicIdeas({...response(ideas()),status:'incomplete'},[]),/ไม่ครบ/);
 assert.throws(()=>parseTopicIdeas(response(ideas().slice(0,2)),[]));
});

test('authenticated requests use the selected OpenAI brain and persist varied results without drafts or production',async()=>{
 const {app}=server(),id=randomUUID();
 assert.equal((await app.request('/app/api/studio/topic-suggestions',{method:'POST'})).status,401);
 assert.equal((await post(app,{request_id:id,model:'claude-opus-5-5'})).status,422);
 assert.equal((await post(app,{request_id:'bad',model:'gpt-6.1-sol'})).status,422);
 assert.equal((await post(app,{request_id:id,source_text:'x'.repeat(6001)})).status,422);
 await db.query('INSERT INTO drafts(topic) VALUES($1)',['หัวข้อที่ทำไปแล้ว']);
 const input={request_id:id,model:'gpt-6.1-terra',reasoning:'medium',story_mode:'general',source_text:'บทความอ้างอิงที่ยังไม่ได้ตรวจ',exclude:['เรื่องเก่าที่เคยสุ่ม']};
 assert.equal((await post(app,input)).status,202);const row=await done(id);assert.equal(row.status,'done');assert.equal(row.ideas.length,5);
 const request=calls.filter(x=>x.method==='POST').at(-1)!.body;
 assert.equal(request.model,'gpt-6.1-terra');assert.equal(request.reasoning.effort,'medium');assert.equal(request.background,true);assert.equal(request.tools,undefined);assert.equal(request.text.format.type,'json_schema');
 assert.ok(request.input[0].content.includes('หัวข้อที่ทำไปแล้ว'));assert.ok(request.input[0].content.includes(input.source_text));assert.ok(request.input[0].content.includes(input.exclude[0]));
 const result=await (await app.request('/app/api/studio/topic-suggestions/'+id,{headers})).json();assert.equal(result.model,'gpt-6.1-terra');assert.equal(result.story_mode,'general');assert.equal(result.ideas.length,5);assert.equal('request' in result,false);
 assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM drafts')).rows[0].n,1);
});

test('concurrent duplicate clicks and response-loss replays share one provider call; new rounds get new seeds',async()=>{
 const {app}=server(),input={request_id:randomUUID(),model:'gpt-6.1-sol',story_mode:'name_story',hero:'เบล'};
 const before=calls.filter(x=>x.method==='POST').length;
 await Promise.all([post(app,input),post(app,input)]);const row=await done(input.request_id);
 assert.equal((await post(server().app,input)).status,200);
 assert.equal(calls.filter(x=>x.method==='POST').length,before+1);
 assert.equal((await post(app,{...input,hero:'เปลี่ยนชื่อ'})).status,409);
 const next={...input,request_id:randomUUID(),exclude:row.ideas};await post(app,next);await done(next.request_id);
 const prompt=calls.filter(x=>x.method==='POST').at(-1)!.body.input[0].content;assert.ok(prompt.includes(next.request_id));assert.ok(prompt.includes(row.ideas[0]));assert.ok(prompt.includes('follow-up story'));
});

test('provider disconnect fails visibly and is never silently replaced by canned ideas or re-created on replay',async()=>{
 const {app}=server(),input={request_id:randomUUID(),model:'gpt-6.1-sol'};fail=true;const n=calls.length;await post(app,input);const row=await done(input.request_id);fail=false;
 assert.equal(row.status,'failed');assert.equal(row.ideas,null);assert.ok(!row.error.includes('mock-secret'));assert.equal(calls.length,n+1);
 assert.equal((await post(app,input)).status,200);assert.equal(calls.length,n+1);
});

test('accepted background IDs are checkpointed while polling',async()=>{
 const {app}=server(),id=randomUUID();queued=true;await post(app,{request_id:id});
 for(let i=0;i<100;i++){const row:any=(await db.query('SELECT * FROM topic_suggestions WHERE id=$1',[id])).rows[0];if(row.response_id)break;await new Promise(r=>setTimeout(r,10));}
 const row:any=(await db.query('SELECT * FROM topic_suggestions WHERE id=$1',[id])).rows[0];assert.match(row.response_id,/^resp_/);assert.equal(row.status,'running');assert.equal(row.request.model,'gpt-6.1-terra');assert.equal(calls.filter(c=>c.method==='POST').at(-1)!.body.model,'gpt-6.1-terra');queued=false;assert.equal((await done(id)).status,'done');assert.ok(calls.some(c=>c.method==='GET'&&c.url.endsWith('/'+row.response_id)));
});

test('restart resumes saved response reads, and leaves ambiguous uncheckpointed creates failed',async()=>{
 const known=randomUUID(),unknown=randomUUID(),request=JSON.stringify({model:'gpt-6.1-sol'});
 await db.query("INSERT INTO topic_suggestions(id,request_hash,request,status,response_id) VALUES($1,'saved',$2,'running','resp_saved')",[known,request]);
 await db.query("INSERT INTO topic_suggestions(id,request_hash,request,status) VALUES($1,'unknown',$2,'running')",[unknown,request]);
 const n=calls.filter(x=>x.method==='POST').length;await server().start();
 assert.equal((await done(known)).status,'done');const lost=await done(unknown);assert.equal(lost.status,'failed');assert.match(lost.error,/ไม่ส่งซ้ำ/);assert.equal(calls.filter(x=>x.method==='POST').length,n);
});
