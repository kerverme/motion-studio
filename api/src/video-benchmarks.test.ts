import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Hono} from 'hono';
import {PGlite} from '@electric-sql/pglite';
import {registerVideoBenchmarks} from './video-benchmarks.js';

test('authenticated history and ratings distinguish unknown cost from zero and keep provider requests private',async()=>{
  const db=new PGlite();
  try{
    await db.exec('CREATE TABLE jobs(id uuid PRIMARY KEY, kind text DEFAULT \'text_video\',stage text,status text,created_at timestamptz,updated_at timestamptz);CREATE TABLE job_events(id bigserial,job_id uuid,status text,message text,created_at timestamptz);'+readFileSync(new URL('../migrations/039_video_model_benchmarks.sql',import.meta.url),'utf8'));
    const {id:job}=(await db.query<any>('INSERT INTO jobs VALUES(gen_random_uuid()) RETURNING id')).rows[0];
    const {id}=(await db.query<any>(`INSERT INTO video_model_benchmarks(job_id,approval_id,slot,scene_id,endpoint_id,model_name,scene_type,original_prompt,compiled_prompt,generation_params,generation_seconds,edited_seconds,estimated_usd)
       VALUES($1,gen_random_uuid(),'s1','shot-1','fal/test','Test','outdoors','original','compiled','{"image_url":"private"}',5,4,0) RETURNING id`,[job])).rows[0];
    const app=new Hono();registerVideoBenchmarks(app,db as any,async(c,next)=>c.req.header('x-test')==='owner'?await next():c.json({},401));
    const base='/app/api/video-intelligence/history', headers={'x-test':'owner','content-type':'application/json'};
    assert.equal((await app.request(base)).status,401);assert.equal((await app.request(base+'?limit=1000',{headers})).status,422);
    const data=await (await app.request(base+'?job_id='+job,{headers})).json();
    assert.equal(data.scenes.length,1);assert.equal(data.scenes[0].actual_usd,null);assert.equal(Number(data.scenes[0].estimated_usd),0);assert.equal(data.scenes[0].generation_params,undefined);
    for(const [rating,status] of [[0,422],[6,422],[4,200]]) assert.equal((await app.request(base+'/'+id+'/rating',{method:'POST',headers,body:JSON.stringify({rating})})).status,status);
    assert.equal((await db.query<any>('SELECT user_rating FROM video_model_benchmarks WHERE id=$1',[id])).rows[0].user_rating,4);
  }finally{await db.close();}
});
