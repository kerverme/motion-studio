import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {registerSceneRevisions,derivativeCalls,copyDerivativeCalls} from './video-derivative.js';

test('scene correction creates a draft only and reuses approved, complete, independent checkpoints',async()=>{
  const db=new PGlite();
  try {
    await db.exec('CREATE TABLE jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid());');
    for(const f of ['025_text_video','039_video_model_benchmarks','041_video_scene_revisions'])await db.exec(readFileSync(new URL('../migrations/'+f+'.sql',import.meta.url),'utf8'));
    const q=async(sql:string,args:any[]=[])=> (await db.query<any>(sql,args)).rows;
    const [{id:job},{id:newJob}]=await q('INSERT INTO jobs SELECT gen_random_uuid() FROM generate_series(1,2) RETURNING id');
    const scenes=['shot_01','shot_02','shot_03','shot_04'].map(id=>({id,narration:id,end_frame:id,production:{prompt:id,endpoint_id:'provider/model',quantity:1}}));
    const fal=scenes.map((s,i)=>({slot:'fal:'+s.id,scene_id:s.id,previous_frame:i===1||i===2}));
    const eleven=scenes.map(s=>({slot:'eleven:'+s.id,scene_id:s.id}));
    const [parent]=await q(`INSERT INTO text_video_plans(id,request_hash,request,plan,approval,status,job_id) VALUES(gen_random_uuid(),'hash',$1,$2,$3,'done',$4) RETURNING *`,[JSON.stringify({topic:'example',engine_version:2}),JSON.stringify({shots:scenes}),JSON.stringify({fal,eleven}),job]);
    const [b]=await q(`INSERT INTO video_model_benchmarks(job_id,approval_id,slot,scene_id,endpoint_id,model_name,scene_type,original_prompt,compiled_prompt,generation_params,generation_seconds,edited_seconds,estimated_usd,quality)
      VALUES($1,gen_random_uuid(),'fal:shot_02','shot_02','provider/model','Example','demo','a','b','{}',5,5,0.2,'{"recommendations":["Show the handoff"]}') RETURNING id`,[job]);
    for(const s of [...fal,...eleven])await q("INSERT INTO text_video_calls(job_id,slot,approval_id,provider,input_hash,status) VALUES($1,$2,gen_random_uuid(),$3,'hash','done')",[job,s.slot,s.slot.split(':')[0]]);
    const app=new Hono();registerSceneRevisions(app,db as any,async(c,next)=>await next());
    const draft='a0000000-0000-4000-8000-000000000000';
    for(let i=0;i<2;i++) {
      const r=await app.request('/app/api/video-intelligence/history/'+b.id+'/revision',{method:'POST',headers:{'idempotency-key':draft}});
      assert.equal(r.status,201);assert.equal((await r.json()).id,draft);
    }
    const [row]=await q('SELECT * FROM text_video_plans WHERE id=$1',[draft]);
    assert.equal(row.repair_from,parent.id);assert.equal(row.job_id,null);assert.equal(row.approval,null);
    const keep=await derivativeCalls(db as any,row);
    assert.deepEqual(keep.map(r=>r.slot).sort(),[...eleven.map(s=>s.slot),'fal:shot_01','fal:shot_04'].sort());
    await copyDerivativeCalls(db as any,row,newJob);
    const seeded=await q('SELECT data FROM text_video_calls WHERE job_id=$1',[newJob]);
    assert.equal(seeded.length,6);assert.ok(seeded.every(r=>r.data.reused_from_job===job));
    row.plan.shots[0].production.prompt='changed';row.plan.shots[3].narration='new narration';
    const edited=await derivativeCalls(db as any,row);
    assert.ok(!edited.some(c=>c.slot==='fal:shot_01'||c.slot==='eleven:shot_04'));
  } finally {await db.close();}
});
