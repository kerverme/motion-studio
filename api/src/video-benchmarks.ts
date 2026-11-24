import type {Hono, Context, Next} from 'hono';
import type pg from 'pg';
import {z} from 'zod';

const prefix='/app/api/video-intelligence/history';
const uuid=z.string().uuid();
export function registerVideoBenchmarks(app:Hono,pool:pg.Pool,guard:(c:Context,next:Next)=>Promise<any>) {
  app.get(prefix,guard,async c=>{
    const job=c.req.query('job_id');
    const limit=z.coerce.number().int().min(1).max(150).safeParse(c.req.query('limit') ?? (job ? 150 : 50));
    if((job && !uuid.safeParse(job).success) || !limit.success) return c.json({error:'ตัวกรองประวัติไม่ถูกต้อง'},422);
    const rows=await pool.query(`SELECT id,job_id,slot,scene_id,endpoint_id,model_name,scene_type,
      original_prompt,compiled_prompt,knowledge_version,generation_seconds,edited_seconds,estimated_usd,
      actual_usd,generation_ms,status,failure_reason,quality,user_rating,created_at,updated_at
      FROM video_model_benchmarks WHERE ($1::uuid IS NULL OR job_id=$1) ORDER BY created_at DESC,slot LIMIT $2`,[job || null,limit.data]);
    if(!job) return c.json({scenes:rows.rows});
    const [state,events]=await Promise.all([
      pool.query("SELECT status,stage,created_at,updated_at FROM jobs WHERE id=$1 AND kind='text_video'",[job]),
      pool.query("SELECT e.status,e.message,e.created_at FROM job_events e JOIN jobs j ON j.id=e.job_id WHERE e.job_id=$1 AND j.kind='text_video' ORDER BY e.id DESC LIMIT 20",[job]),
    ]);
    return c.json({scenes:rows.rows,job:state.rows[0]?{...state.rows[0],events:events.rows}:null,events:events.rows});
  });
  app.post(prefix+'/:id/rating',guard,async c=>{
    if(!uuid.safeParse(c.req.param('id')).success) return c.json({error:'ไม่พบฉาก'},404);
    const body=z.object({rating:z.number().int().min(1).max(5)}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!body.success) return c.json({error:'ให้คะแนนตั้งแต่ 1 ถึง 5'},422);
    const row=await pool.query('UPDATE video_model_benchmarks SET user_rating=$2,updated_at=now() WHERE id=$1 RETURNING id,user_rating',[c.req.param('id'),body.data.rating]);
    return row.rows.length ? c.json(row.rows[0]) : c.json({error:'ไม่พบฉาก'},404);
  });
}
