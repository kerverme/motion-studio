import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
process.env.MOTION_LLM_PROVIDER='openai';
process.env.OPENAI_API_KEY='mock-key';
const {registerStudio}=await import('./studio.js');

test('general mode and source text persist with Sol and survive rewrite; old clients retain name-series',async()=>{
  const id='10000000-0000-0000-0000-000000000020';
  const source='บทความและแหล่งต้นทางสำหรับเล่าเรื่อง '.repeat(80).trim();
  const inserts:{sql:string,args:any[]}[]=[];
  const row={id,status:'ready',topic:'รูทีนตอนเช้า',note:null,story_mode:'general',source_text:source,model:'gpt-6.1-sol',reasoning:'medium',characters:[],style:'classic',music_mode:'default'};
  const pool={query:async(sql:string,args:any[]=[])=>{
    if(sql.startsWith('SELECT count(*)'))return {rows:[{n:0}]};
    if(sql.startsWith('SELECT * FROM drafts WHERE id='))return {rows:[row]};
    if(sql.startsWith('INSERT INTO drafts')){inserts.push({sql,args});return {rows:[{id}]};}
    return {rows:[],rowCount:0};
  }};
  const nativeTimeout=globalThis.setTimeout;
  globalThis.setTimeout=((cb:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:cb,ms===8000?0:ms,...args)) as typeof setTimeout;
  const app=new Hono();
  try{
    registerStudio(app,pool as any,{guard:async(_c,next)=>next(),createJob:async()=>({status:200,body:{}}),estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    // Configuration gate depends on runtime keys; set before the module import in this process if no key is available.
    process.env.OPENAI_API_KEY ||= 'mock-key';process.env.FIRECRAWL_API_KEY ||= 'mock-firecrawl';process.env.ANTHROPIC_API_KEY ||= 'mock-key';
    const res=await app.request('/app/api/studio/drafts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({topic:row.topic,story_mode:'general',source_text:source,model:row.model,characters:[]})});
    assert.equal(res.status,201,await res.text());
    assert.equal(inserts[0].args[3],'gpt-6.1-sol');assert.equal(inserts[0].args[8],'general');assert.equal(inserts[0].args[9],source);assert.equal(inserts[0].args[5],'[]');
    const rewrite=await app.request(`/app/api/studio/drafts/${id}/rewrite`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:'อธิบายด้วยกราฟิก ไม่ใช้คน'})});
    assert.equal(rewrite.status,201);assert.equal(inserts[1].args[11],'general');assert.equal(inserts[1].args[12],source);assert.equal(inserts[1].args[4],'gpt-6.1-sol');
    await app.request('/app/api/studio/drafts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({topic:'คนชื่อเบลในประเทศไทยมีกี่คน'})});
    assert.equal(inserts[2].args[8],'name_story');
  }finally{globalThis.setTimeout=nativeTimeout;}
});
