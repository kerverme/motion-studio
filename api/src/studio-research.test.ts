import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Hono} from 'hono';
import {PGlite} from '@electric-sql/pglite';
process.env.MOTION_LLM_PROVIDER='openai';
process.env.OPENAI_API_KEY='mock-key';
process.env.FIRECRAWL_API_KEY='mock-firecrawl';
const {registerStudio}=await import('./studio.js');

test('studio enforces exact OpenAI read before fallback, caches deeper extraction and protects budget approval',async()=>{
  const db=new PGlite();
  await db.exec("CREATE TABLE drafts(id uuid PRIMARY KEY,parent_id uuid,usage jsonb NOT NULL DEFAULT '{}',research jsonb NOT NULL DEFAULT '[]');");
  await db.exec(readFileSync(new URL('../migrations/015_research_budget.sql',import.meta.url),'utf8'));
  const id='10000000-0000-0000-0000-000000000051',job='10000000-0000-0000-0000-000000000052',url='https://official.example/full-table';
  let status='queued',turns=0,firecrawlCalls=0,openaiReads=0,finalUsage:any,fetchFailure:unknown;
  let done!:()=>void;const finished=new Promise<void>(r=>done=r);
  const row={id,research_job_id:job,topic:'หลักฐานจากตารางต้นฉบับ',story_mode:'general',model:'gpt-6.1-sol',reasoning:'medium',characters:[]};
  const query=async(sql:string,args:any[]=[])=>{
    if(sql.includes("WHERE status IN ('researching','writing')"))return {rows:[]};
    if(sql.includes("SELECT id FROM drafts WHERE status='queued'"))return {rows:status==='queued'?[{id}]:[]};
    if(sql.startsWith('SELECT * FROM drafts WHERE id='))return {rows:[{...row,status}]};
    if(sql.startsWith('SELECT id, draft FROM drafts'))return {rows:[]};
    if(sql.startsWith("UPDATE drafts SET status='researching'")){status='researching';return {rows:[]};}
    if(sql.startsWith('UPDATE drafts SET usage=')){finalUsage=JSON.parse(args[1]);return {rows:[]};}
    if(sql.startsWith('UPDATE drafts SET log'))return {rows:[]};
    if(sql.startsWith("UPDATE drafts SET status='failed'")){status='failed';done();return {rows:[]};}
    return db.query(sql,args);
  };
  const pool={query,connect:async()=>({query:db.query.bind(db),release(){}})};
  const nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout;
  globalThis.fetch=async(target,init)=>{
    try{
      if(String(target).includes('firecrawl.dev')){
        firecrawlCalls++;assert.equal(openaiReads,1);
        assert.equal((await db.query<any>('SELECT committed_credits FROM research_jobs WHERE id=$1',[job])).rows[0].committed_credits,3);
        return Response.json({success:true,data:{markdown:'The complete original source table, including its limitations.',metadata:{title:'Official table',sourceURL:url,statusCode:200}}});
      }
      const body=JSON.parse(String(init?.body));
      if(String(body.instructions).startsWith('You verify source pages')){
        openaiReads++;
        return Response.json({id:'resp_exact',status:'completed',output:[{type:'web_search_call',status:'completed',action:{type:'open_page',url}},{type:'message',content:[{type:'output_text',text:'Only the excerpt is available; the table cells are not shown.'}]}],usage:{input_tokens:10,output_tokens:10}});
      }
      turns++;
      assert.equal(body.tools.some((t:any)=>t.name==='firecrawl_search'),false,'no paid broad search tool is exposed');
      if(turns===2)assert.ok(body.input.some((x:any)=>x.type==='function_call_output'&&x.output.includes('OpenAI Web Search first')));
      if(turns===5)throw new Error('Stop after the cache verification');
      const args=turns===2?{url}:{url,use_firecrawl:true,fallback_reason:'The original table cells are missing from the OpenAI excerpt.'};
      return Response.json({id:'resp_'+turns,status:'completed',output:[{type:'function_call',name:'read_page',call_id:'read_'+turns,arguments:JSON.stringify(args)}],usage:{input_tokens:10,output_tokens:10}});
    }catch(e){if(!(e instanceof Error&&e.message==='Stop after the cache verification'))fetchFailure=e;throw e;}
  };
  globalThis.setTimeout=((cb:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:cb,ms===8000?0:ms,...args)) as typeof setTimeout;
  const app=new Hono();
  try{
    registerStudio(app,pool as any,{guard:async(c,next)=>c.req.header('authorization')==='Bearer owner'?next():c.json({error:'unauthorized'},401),createJob:async()=>({status:200,body:{}}),estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    await finished;
    if(fetchFailure)throw fetchFailure;
    assert.equal(firecrawlCalls,1);assert.equal(openaiReads,1);assert.equal(finalUsage.firecrawl_budget.committed,3);
    const endpoint=`/app/api/studio/drafts/${id}/research-budget`;
    const request=(body:any,authed=true)=>app.request(endpoint,{method:'POST',headers:{'content-type':'application/json',...(authed?{authorization:'Bearer owner'}:{})},body:JSON.stringify(body)});
    assert.equal((await request({limit:40,approved:true,confirmation:'APPROVE FIRECRAWL TOTAL 40'},false)).status,401);
    assert.equal((await request({limit:40})).status,422);
    assert.equal((await request({limit:40,approved:true,confirmation:'APPROVE FIRECRAWL TOTAL 50'})).status,422);
    assert.equal((await db.query('SELECT * FROM research_budget_approvals')).rows.length,0);
    const approved=await request({limit:40,approved:true,confirmation:'APPROVE FIRECRAWL TOTAL 40'});
    assert.equal(approved.status,200,await approved.text());
    assert.equal((await db.query<any>('SELECT credit_limit FROM research_jobs WHERE id=$1',[job])).rows[0].credit_limit,40);
    assert.equal((await db.query('SELECT * FROM research_budget_approvals')).rows.length,1);
  }finally{globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;await db.close();}
});
