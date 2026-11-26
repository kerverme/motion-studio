import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('../tests/studio-fixture.js');
for(const [accessible,count] of [[true,1],[false,1],[true,6]] as const)test(`selected trend rechecks ${count} source(s) before planning; accessible=${accessible}`,async()=>{
  const url='https://www.tiktok.com/@science/video/123456789';
  const urls=Array.from({length:count},(_,i)=>i===0?url:url+'-'+i);
  const row={id:'10000000-0000-0000-0000-000000000777',topic:'สีท้องฟ้าเปลี่ยนได้อย่างไร',story_mode:'general',model:'gpt-6.1-terra',characters:[],auto_produce:false,trend_context:{sources:[{url,views:999999,supporting_sources:urls.slice(1).map(url=>({url}))}],trend_ids:[],warning:null}};
  let status='queued',saved:any,planning=false,checks=0,fetchError:unknown,resolve!:()=>void;
  const done=new Promise<void>(r=>resolve=r),nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout;
  const timeout=nativeTimeout(resolve,5000);
  const pool:any={query:async(sql:string,args:any[]=[])=>{
    if(sql.includes("WHERE status IN ('researching','writing')"))return {rows:[]};
    if(sql.includes("SELECT id FROM drafts WHERE status='queued'"))return {rows:status==='queued'?[{id:row.id}]:[]};
    if(sql.startsWith('SELECT * FROM drafts WHERE id='))return {rows:[{...row,status}]};
    if(sql.startsWith("UPDATE drafts SET status='researching'"))status='researching';
    if(sql.startsWith('UPDATE drafts SET trend_context='))saved=JSON.parse(args[1]);
    if(sql.startsWith("UPDATE drafts SET status='failed'")){status='failed';resolve();}
    return {rows:[],rowCount:1};
  }};
  globalThis.fetch=async(_url,init)=>{try{
    const body=JSON.parse(String(init?.body));
    if(body.instructions?.startsWith('You verify source pages')){
      const batch=JSON.parse(body.input[0].content.split('\n').at(-1));
      assert.deepEqual(batch,urls.slice(checks*4,checks*4+4));checks++;assert.equal(planning,false);
      return Response.json({id:'resp_trend_check_'+checks,status:'completed',output:[...(accessible?batch.map((url:string)=>({type:'web_search_call',status:'completed',action:{type:'open_page',url}})):[]),{type:'message',content:[{type:'output_text',text:accessible?'Observed source: this post asks about sky colors. No medical claims.':'Source unavailable; no claims verified.'}]}],usage:{input_tokens:20,output_tokens:20}});
    }
    planning=true;assert.equal(checks,Math.ceil(count/4));assert.ok(saved.rechecked_at);assert.deepEqual(saved.rechecked_urls,accessible?urls:[]);assert.equal(Boolean(saved.warning),!accessible);
    const input=JSON.stringify(body.input);assert.match(input,/Fresh source check before scriptwriting/);assert.match(input,/Never count this saved context as a fetched page/);
    // Stop this dispatcher test before drawing or any production request.
    return Response.json({error:{code:'test_stop_after_verified_order'}},{status:400});
  }catch(e){fetchError=e;throw e;}};
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{registerStudio(new Hono(),pool,{guard:async(_c,n)=>n(),createJob:async()=>{throw new Error('must not produce')},estimateCredits:()=>0,validate:()=>[],researchFreshness:()=>[]});await done;if(fetchError)throw fetchError;assert.equal(planning,true);assert.equal(checks,Math.ceil(count/4));}finally{clearTimeout(timeout);globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;}
});
