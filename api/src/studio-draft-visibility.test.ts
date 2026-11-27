import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {FALLBACK_MODELS} from './openai-models.js';

test('legacy Reverse approvals stay in history without occupying Studio draft slots, detail routes or quota',async t=>{
  process.env.MOTION_LLM_PROVIDER='openai';
  process.env.OPENAI_API_KEY='test-only';
  const {registerStudio}=await import('../tests/studio-fixture.js');
  const db=new PGlite();
  t.after(()=>db.close());
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(name,dir),'utf8'));

  const real=await db.query<{id:string}>(`INSERT INTO drafts(topic,status,source_type)
    VALUES ('Cartoon','ready','studio'),('Nividia','submitted','community') RETURNING id`);
  const legacy=await db.query<{id:string}>(`INSERT INTO drafts(topic,status,creative)
    SELECT 'Cartoon','submitted',jsonb_build_object('reverse_project',gen_random_uuid(),'quote_id',gen_random_uuid())
    FROM generate_series(1,45) RETURNING id`);
  const pool={query:async(sql:string,args:any[]=[])=>sql.startsWith("WITH candidates AS")?{rows:[]}:db.query(sql,args)};
  const app=new Hono();
  const timeout=globalThis.setTimeout;
  const timers=t.mock.method(globalThis,'setTimeout',(fn:any,ms?:number,...args:any[])=>ms===8000?undefined:timeout(fn,ms,...args));
  try{
    registerStudio(app,pool as any,{models:FALLBACK_MODELS,guard:async(_c,next)=>next(),estimateCredits:()=>1,
      validate:()=>[],researchFreshness:()=>[],createJob:async()=>{throw Error('unexpected production');}});
  }finally{timers.mock.restore();}

  const path='/app/api/studio/drafts',hidden=path+'/'+legacy.rows[0].id;
  const list=await (await app.request(path)).json();
  assert.deepEqual(list.drafts.map((d:any)=>d.id).sort(),real.rows.map(r=>r.id).sort());
  assert.equal((await (await app.request('/app/api/studio/status')).json()).drafts_today,2);
  assert.equal((await app.request(path+'/'+real.rows[0].id)).status,200);
  for(const url of [hidden,hidden+'/diagnostics'])assert.equal((await app.request(url)).status,404);
  for(const action of ['produce','rewrite'])assert.equal((await app.request(hidden+'/'+action,{method:'POST'})).status,404);
  const created=await app.request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({topic:'Cartoon',story_mode:'general'})});
  assert.equal(created.status,201,await created.clone().text());
  assert.equal((await (await app.request('/app/api/studio/status')).json()).drafts_today,3);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::int AS n FROM drafts WHERE creative ? 'reverse_project'")).rows[0].n,45);
});
