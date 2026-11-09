import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {draftRequest} from './draft-request.js';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
const {registerStudio}=await import('./studio.js');
const db=new PGlite();
after(()=>db.close());

test('keys are scoped, bounded, and stable when JSON field order changes',()=>{
  assert.deepEqual(draftRequest('request-0000000001','create',{b:2,a:[1]}),draftRequest('request-0000000001','create',{a:[1],b:2}));
  assert.notEqual(draftRequest('request-0000000001','create',{}).key,draftRequest('request-0000000001','rewrite:123',{}).key);
  assert.throws(()=>draftRequest('short','create',{}));
});

test('Postgres prevents concurrent duplicate drafts and rewrites, and replays survive process restart',async()=>{
  const dir=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(file,dir),'utf8'));
  // Migration can also be reapplied, without changing legacy rows.
  await db.exec(readFileSync(new URL('016_draft_requests.sql',dir),'utf8'));
  const pool={query:async(sql:string,args:any[]=[])=>{
    // Exercise routes and real PostgreSQL uniqueness, without starting paid generation.
    if(sql.startsWith("SELECT id FROM drafts WHERE status='queued'"))return {rows:[]};
    return db.query(sql,args);
  }};
  function server(){const app=new Hono();registerStudio(app,pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('must not produce')},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});return app;}
  const originalTimeout=globalThis.setTimeout;
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>ms===8000?originalTimeout(()=>{},0):originalTimeout(fn,ms,...args)) as typeof setTimeout;
  try{
    const app=server();
    const body={topic:'เรื่องแก้วน้ำบนโต๊ะ',story_mode:'general',source_text:'นิทานสมมติ',model:'gpt-6.1-sol',characters:[],auto_produce:false};
    const send=(app:Hono,path:string,key:string,payload:any)=>app.request(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(payload)});
    const path='/app/api/studio/drafts',key='request-concurrent-001';
    const responses=await Promise.all([send(app,path,key,body),send(app,path,key,body)]);
    assert.deepEqual(responses.map(r=>r.status),[201,201]);
    const [one,two]=await Promise.all(responses.map(r=>r.json()));assert.equal(one.id,two.id);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM drafts')).rows[0].n,1);
    assert.equal((await send(server(),path,key,body)).status,201,'new process returns existing ID');
    assert.equal((await send(app,path,key,{...body,topic:'changed topic'})).status,409);
    // A failed draft retains mode, sources, model and saved art on Retry.
    await db.query("UPDATE drafts SET status='failed',storyboard=$2,artwork=$3 WHERE id=$1",[one.id,JSON.stringify({story_mode:'general',script:[],shots:[]}),JSON.stringify({cast:[],scenes:[],art:''})]);
    const rewrites=await Promise.all([send(app,path+'/'+one.id+'/rewrite','request-rewrite-001',{}),send(app,path+'/'+one.id+'/rewrite','request-rewrite-001',{})]);
    assert.deepEqual(rewrites.map(r=>r.status),[201,201]);
    const children=await Promise.all(rewrites.map(r=>r.json()));assert.equal(children[0].id,children[1].id);
    const child:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[children[0].id])).rows[0];
    assert.equal(child.story_mode,'general');assert.equal(child.source_text,body.source_text);assert.equal(child.model,body.model);assert.deepEqual(child.characters,[]);assert.equal(child.research_job_id,(await db.query<{research_job_id:string}>('SELECT research_job_id FROM drafts WHERE id=$1',[one.id])).rows[0].research_job_id);assert.equal(child.storyboard.story_mode,'general');
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM drafts')).rows[0].n,2);
    // Null keys preserve compatibility and allow deliberate new drafts.
    for(let i=0;i<2;i++)assert.equal((await app.request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,201);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM drafts')).rows[0].n,4);
  }finally{globalThis.setTimeout=originalTimeout;}
});
