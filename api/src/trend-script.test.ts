import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('./studio.js');
for(const accessible of [true,false])test(`selected trend is rechecked before script planning; source accessible=${accessible}`,async()=>{
  const url='https://www.tiktok.com/@science/video/123456789';
  const row={id:'10000000-0000-0000-0000-000000000777',topic:'สีท้องฟ้าเปลี่ยนได้อย่างไร',story_mode:'general',model:'gpt-6.1-terra',characters:[],auto_produce:false,trend_context:{sources:[{url,views:999999}],trend_ids:[],warning:null}};
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
      checks++;assert.equal(planning,false);assert.match(body.input[0].content,/123456789/);
      return Response.json({id:'resp_trend_check',status:'completed',output:[...(accessible?[{type:'web_search_call',status:'completed',action:{type:'open_page',url}}]:[]),{type:'message',content:[{type:'output_text',text:accessible?'Observed source: this post asks about sky colors. No medical claims.':'Source unavailable; no claims verified.'}]}],usage:{input_tokens:20,output_tokens:20}});
    }
    planning=true;assert.equal(checks,1);assert.ok(saved.rechecked_at);assert.deepEqual(saved.rechecked_urls,accessible?[url]:[]);assert.equal(Boolean(saved.warning),!accessible);
    const input=JSON.stringify(body.input);assert.match(input,/Fresh source check before scriptwriting/);assert.match(input,/Never count this saved context as a fetched page/);
    // Stop this dispatcher test before drawing or any production request.
    return Response.json({error:{code:'test_stop_after_verified_order'}},{status:400});
  }catch(e){fetchError=e;throw e;}};
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{registerStudio(new Hono(),pool,{guard:async(_c,n)=>n(),createJob:async()=>{throw new Error('must not produce')},estimateCredits:()=>0,validate:()=>[],researchFreshness:()=>[]});await done;if(fetchError)throw fetchError;assert.equal(planning,true);assert.equal(checks,1);}finally{clearTimeout(timeout);globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;}
});
