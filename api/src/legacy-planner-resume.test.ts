import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {legacyPlannerReceipt,registerLegacyPlannerResume} from './legacy-planner-resume.js';

const error='ระบบรีสตาร์ทระหว่างเขียน กด "เขียนใหม่" เพื่อเริ่มอีกครั้ง';
const model='gpt-6.2-sol';
const logs = Array.from({length:4},(_,i)=>{
  const lines = ['รอบที่ '+(i+1)+': ค้นข้อมูล/วางบท ('+model+')','OpenAI รับงานแล้ว กำลังประมวลผลเบื้องหลัง [resp_main'+(i+1)+']'];
  if(i<3) lines.push('web search: GDP','OpenAI รับงานแล้ว กำลังประมวลผลเบื้องหลัง [resp_nested'+(i+1)+']');
  return lines.map(msg=>({msg}));
}).flat();
const usage={turns:3,input_tokens:80096,output_tokens:1866};
const row={status:'failed',error,model,usage,log:logs};
test('old writer must have committed the previous round and one unequivocal main acceptance before interrupt',()=>{
  const expected={turn:4,response_id:'resp_main4'};
  assert.deepEqual(legacyPlannerReceipt(row),expected);
  assert.deepEqual(legacyPlannerReceipt({...row,log:[...logs,{msg:'OpenAI ยังประมวลผลอยู่ (2 นาที · in_progress)'}]}),expected);
  for(const patch of [
    {log:[...logs,{msg:'OpenAI รับงานแล้ว กำลังประมวลผลเบื้องหลัง [resp_nested4]'}]},
    {log:[...logs,{msg:'web search: GDP'}]}, {log:logs.slice(0,-1)},
    {log:logs.slice(4)}, {usage:{turns:4}}, {usage:{turns:2}}, {error:'authorization pending'},
    {removed_at:new Date()}, {job_id:'queued'}, {status:'writing'}, {storyboard:{}}, {planner_checkpoint:{}},
  ])assert.equal(legacyPlannerReceipt({...row,...patch}),null);
});

const db=new PGlite();
const query=(sql:string,args:any[]=[])=>db.query<any>(sql,args);
before(async()=>{await db.exec(`CREATE TABLE drafts(id uuid primary key default gen_random_uuid(),status text,error text,model text,usage jsonb,log jsonb,research jsonb,
   job_id uuid,draft jsonb,storyboard jsonb,creative jsonb,removed_at timestamptz,planner_checkpoint jsonb,auto_produce boolean,updated_at timestamptz);`);});
after(()=>db.close());
async function fixture(){
  const urls=[{kind:'web',results:[{url:'https://example.com/source'}]}];
  const {id}=(await query(`INSERT INTO drafts(status,error,model,usage,log,research,auto_produce) VALUES('failed',$1,$2,$3,$4,$5,true) RETURNING id`,
    [error,model,JSON.stringify(usage),JSON.stringify(logs),JSON.stringify(urls)])).rows[0];
  let wakes=0;const reads:string[]=[];
  const response:any={id:'resp_main4',status:'completed',tools:[{type:'function',name:'plan_story'}]};
  const app=new Hono();
  registerLegacyPlannerResume(app,{query} as any,{
    guard:async(c,n)=>c.req.header('x-owner')==='yes'?n():c.json({},401),wake:()=>{wakes++;},
    readResponse:async id=>{reads.push(id);return response;},
  });
  const request=(body?:any,owner=true)=>app.request('/app/api/studio/drafts/'+id+'/resume',{method:body?'POST':'GET',headers:{...(owner?{'x-owner':'yes'}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {id,urls,reads,response,request,wakes:()=>wakes};
}
test('legacy resume GET only checks the stored response; explicitly continuing once preserves the same draft ID, evidence and spend',async()=>{
  const f=await fixture();
  assert.equal((await f.request(undefined,false)).status,401);
  const preflight=await f.request();
  assert.equal(preflight.status,200);assert.equal((await preflight.json() as any).provider_status,'completed');
  assert.equal(f.wakes(),0);assert.equal((await query('SELECT status FROM drafts WHERE id=$1',[f.id])).rows[0].status,'failed');
  const confirmation={confirm:true,response_id:'resp_main4'};
  assert.equal((await f.request({...confirmation,response_id:'resp_nested3'})).status,409);
  assert.equal((await f.request({...confirmation,confirm:false})).status,422);
  const results=await Promise.all([f.request(confirmation),f.request(confirmation)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,202]);assert.equal(f.wakes(),1);
  const d=(await query('SELECT * FROM drafts WHERE id=$1',[f.id])).rows[0];
  assert.equal(d.status,'queued');assert.equal(d.error,null);assert.equal(d.auto_produce,false);
  assert.deepEqual(d.planner_checkpoint,{turn:3,provider:'openai',version:1,legacy:true,calls:{main:{response_id:'resp_main4'}}});
  assert.deepEqual(d.research,f.urls);assert.deepEqual(d.usage,usage);
  assert.ok(f.reads.every(id=>id==='resp_main4'));
});
test('unavailable or nested responses cannot requeue or dispatch new work',async()=>{
  const f=await fixture();
  f.response.tools=[{type:'web_search'}];
  assert.equal((await f.request({confirm:true,response_id:'resp_main4'})).status,409);
  f.response.tools=[{type:'function',name:'plan_story'}];f.response.status='failed';
  assert.equal((await f.request()).status,409);assert.equal(f.wakes(),0);
});
