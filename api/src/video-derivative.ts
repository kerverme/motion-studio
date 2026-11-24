import type {Hono,Context,Next} from 'hono';
import type pg from 'pg';
import {z} from 'zod';
import {digest} from './text-video-contract.js';

type DB=Pick<pg.Pool,'query'>;
async function original(db:DB,row:any) {
  if(!row.repair_from) return null;
  const parent=(await db.query('SELECT id,job_id,status,plan,request,approval FROM text_video_plans WHERE id=$1',[row.repair_from])).rows[0];
  if(!parent?.job_id || parent.status!=='done' || !parent.approval || parent.request.engine_version!==2) throw new Error('ยังไม่พบงานต้นฉบับที่ผลิตเสร็จและยืนยันค่าใช้จ่ายแล้ว');
  return parent;
}
export async function derivativeApproval(db:DB,row:any) {return (await original(db,row))?.approval || null;}
const unchanged=(a:unknown,b:unknown)=>digest(a ?? null)===digest(b ?? null);
function videoSpec(s:any) {
  const p=s.production || {};
  return [p.endpoint_id,p.prompt,p.duration,p.edited_duration,p.resolution,p.audio,p.reference_url || '',s.end_frame];
}
// A new primary clip invalidates the next scene only while it inherits the preceding final frame.
export function reusableSlots(row:any,parent:any):Set<string> {
  const slots=new Set<string>();
  let previousChanged=false;
  for(const scene of row.plan.shots) {
    const old=parent.plan.shots.find((s:any)=>s.id===scene.id);
    const fal=parent.approval.fal.filter((f:any)=>f.scene_id===scene.id);
    const different=!old || scene.id===row.repair_scene || !unchanged(videoSpec(old),videoSpec(scene));
    const frameChanged:boolean=different || previousChanged && fal.some((f:any)=>f.previous_frame);
    if(!frameChanged) for(const item of fal.slice(0,scene.production.quantity ?? 1)) slots.add(item.slot);
    previousChanged=frameChanged;
    if(!old || old.production?.audio!==scene.production?.audio || !unchanged(old.production?.edited_duration,scene.production?.edited_duration)) continue;
    for(const item of parent.approval.eleven) {
      if(item.slot==='eleven:'+scene.id && old.narration===scene.narration) slots.add(item.slot);
      if(item.slot==='sfx:'+scene.id && unchanged(old.production?.sfx,scene.production?.sfx)) slots.add(item.slot);
    }
  }
  return slots;
}
export async function derivativeCalls(db:DB,row:any):Promise<any[]> {
  const parent=await original(db,row);
  if(!parent)return [];
  const slots=reusableSlots(row,parent);
  const latest=(await db.query('SELECT DISTINCT ON(slot) * FROM text_video_calls WHERE job_id=$1 ORDER BY slot,created_at DESC',[parent.job_id])).rows;
  return latest.filter(c=>slots.has(c.slot) && c.status==='done');
}
export async function copyDerivativeCalls(db:DB,row:any,newJobId:string) {
  const calls=await derivativeCalls(db,row);
  for(const c of calls) {
    await db.query(`INSERT INTO text_video_calls(job_id,slot,approval_id,provider,input_hash,status,request_id,data)
      VALUES ($1,$2,$3,$4,$5,'done',$6,$7) ON CONFLICT DO NOTHING`,
    [newJobId,c.slot,c.approval_id,c.provider,c.input_hash,c.request_id,JSON.stringify({...c.data,reused_from_job:c.job_id})]);
  }
}
export function registerSceneRevisions(app:Hono,pool:pg.Pool,guard:(c:Context,next:Next)=>Promise<any>) {
  app.post('/app/api/video-intelligence/history/:id/revision',guard,async c=>{
    const benchmark=z.string().uuid().safeParse(c.req.param('id'));
    const id=z.string().uuid().safeParse(c.req.header('idempotency-key'));
    if(!id.success||!benchmark.success)return c.json({error:'ต้องมีรหัสคำขอและรหัสฉากที่ถูกต้อง'},422);
    const source=(await pool.query(`SELECT p.*,b.scene_id,b.quality FROM video_model_benchmarks b
      JOIN text_video_plans p ON p.job_id=b.job_id WHERE b.id=$1 AND p.status='done'`,[benchmark.data])).rows[0];
    if(!source?.quality || source.request.engine_version!==2) return c.json({error:'ต้องมีผลตรวจภาพจากงานที่ผลิตเสร็จ'},409);
    const note='แผนแก้ '+source.scene_id+' · ตรวจคำแนะนำ ปรับพรอมป์ แล้วขอราคาเฉพาะส่วนที่ต้องผลิตอีกครั้ง';
    await pool.query(`INSERT INTO text_video_plans(id,request_hash,request,plan,status,repair_from,repair_scene,repair_benchmark_id,progress)
      VALUES ($1,$2,$3,$4,'ready',$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [id.data,digest({parent:source.id,benchmark:benchmark.data}),JSON.stringify(source.request),JSON.stringify(source.plan),source.id,source.scene_id,benchmark.data,note]);
    const row=(await pool.query('SELECT id,status,repair_benchmark_id FROM text_video_plans WHERE id=$1',[id.data])).rows[0];
    if(row.repair_benchmark_id!==benchmark.data)return c.json({error:'รหัสคำขอนี้ถูกใช้กับแผนอื่น'},409);
    return c.json({id:row.id,status:row.status,scene_id:source.scene_id,quality:source.quality},201);
  });
}
