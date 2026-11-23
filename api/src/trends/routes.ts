import type {Hono,Context,Next} from 'hono';
import type pg from 'pg';
import {z} from 'zod';
import {createHash,randomUUID} from 'node:crypto';
import {eligibleTrends,publicTrend} from './store.js';
import {PgResearchBudget} from '../firecrawl-budget.js';
import {readModels,type ModelSource} from '../openai-models.js';
export const trendSettings=()=>({enabled:process.env.MOTION_TREND_RESEARCH_ENABLED==='1',engine:'alexandria',verified_platforms:(process.env.TREND_VERIFIED_PLATFORMS||'').split(',').filter(x=>['tiktok','instagram','youtube'].includes(x)),window_days:7,refresh_hours:null,minimum_score:Number(process.env.TREND_MIN_SCORE)||70,timezone:'Asia/Bangkok',credit_limit:25,research_model:process.env.TREND_RESEARCH_MODEL||null});
const Request=z.object({request_id:z.string().uuid(),platform:z.enum(['tiktok','instagram','youtube','both']).default('both'),query:z.string().trim().min(2).max(400).default('เรื่องใกล้ตัว วิทยาศาสตร์ เทคโนโลยี และกระแสสังคมไทย'),audience:z.string().trim().min(2).max(200).default('คนไทยทั่วไป'),count:z.number().int().min(1).max(10).default(10),model:z.string().min(1).max(100).optional()});
export function registerTrendRoutes(app:Hono,pool:pg.Pool,guard:(c:Context,next:Next)=>Promise<any>,models?:ModelSource){
  const presentRun=async(r:any)=>{
    const budget=r.budget_id?await new PgResearchBudget(pool).snapshot(r.budget_id):null;
    const unknown=r.budget_id?Number((await pool.query('SELECT count(*)::int AS n FROM firecrawl_requests WHERE research_job_id=$1 AND reported_credits IS NULL',[r.budget_id])).rows[0].n):0;
    return {...r,firecrawl:budget?{...budget,actual:unknown?null:budget.reported,unreported_calls:unknown,estimated:budget.committed}:null};
  };
  app.get('/app/api/studio/trends',guard,async c=>{
    const platform=['tiktok','instagram','youtube'].includes(c.req.query('platform')||'')?c.req.query('platform')!:'both';
    const settings=trendSettings();
    const runs=(await pool.query(`SELECT r.id,COALESCE(j.state,r.status) AS status,r.request,r.created_at,r.finished_at,r.error,r.duration_ms,r.evidence_count,r.eligible_count,r.details,j.budget_id,
      (SELECT COALESCE(sum(estimated_usd),0) FROM trend_provider_calls WHERE research_run_id=r.id) AS known_estimated_usd,
      (SELECT count(*)::int FROM trend_provider_calls WHERE research_run_id=r.id AND estimated_usd IS NULL) AS unpriced_calls
      FROM trend_research_runs r LEFT JOIN trend_alexandria_jobs j ON j.run_id=r.id ORDER BY r.created_at DESC LIMIT 12`)).rows;
    const catalog=(await pool.query('SELECT provider,tools,checked_at,error FROM trend_alexandria_catalog')).rows.map(r=>({provider:r.provider,checked_at:r.checked_at,error:r.error,tools:r.tools.filter((t:any)=>/^(tiktok|instagram|youtube)\//.test(t.capability)).map((t:any)=>({capability:t.capability,credits:t.creditsCost,maximum:t.billing?.maxCredits??null,per_record:t.perRecord}))}));
    const heartbeat=(await pool.query("SELECT data FROM integrations WHERE provider='alexandria_worker'")).rows[0]?.data||null;
    return c.json({...settings,worker:heartbeat,catalog,trends:settings.enabled?(await eligibleTrends(pool,platform)).map(publicTrend):[],runs:await Promise.all(runs.map(presentRun))});
  });
  app.post('/app/api/studio/trends/refresh',guard,async c=>{
    const settings=trendSettings();if(!settings.enabled)return c.json({error:'ระบบค้นหาเทรนด์ยังไม่เปิดใช้งาน โหมด Creative ใช้งานได้ตามปกติ'},503);
    const parsed=Request.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:'ข้อมูลคำขอค้นหาเทรนด์ไม่ถูกต้อง'},422);
    const {request_id,model:selectedModel,...input}=parsed.data;
    const hashRequest=(model:string)=>createHash('sha256').update(JSON.stringify({...input,model})).digest('hex');
    const lookup=`SELECT j.run_id,j.state,a.request_hash,r.request->>'model' AS model
      FROM trend_alexandria_requests a JOIN trend_alexandria_jobs j ON j.run_id=a.run_id
      JOIN trend_research_runs r ON r.id=j.run_id WHERE a.request_id=$1`;
    const replay=(saved:{run_id:string;state:string;model:string;request_hash:string})=>
      saved.request_hash===hashRequest(selectedModel??saved.model) ? c.json({id:saved.run_id,status:saved.state,model:saved.model},200) : c.json({error:'คำขอเดิมใช้ข้อมูลอื่นไปแล้ว'},409);
    const saved=(await pool.query(lookup,[request_id])).rows[0];
    if(saved)return replay(saved);
    const model=selectedModel??settings.research_model;
    if(!model || !(await readModels(models)).ids.includes(model))return c.json({error:'กรุณาเลือกสมองค้นหาเทรนด์จากรายชื่อ OpenAI ที่บัญชีใช้ได้'},422);
    const request={...input,model},hash=hashRequest(model);
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734991))',[request_id]);
      const existing=(await db.query(lookup,[request_id])).rows[0];
      if(existing){await db.query('COMMIT');return replay(existing);}
      // A shared content/time slot also deduplicates simultaneous tabs and double clicks.
      const slot='alexandria:'+hash+':'+Math.floor(Date.now()/600000);
      const run=(await db.query("INSERT INTO trend_research_runs(request_key,request,status,heartbeat_at,details) VALUES($1,$2,'running',now(),'{\"engine\":\"alexandria\"}') ON CONFLICT(request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING id",[slot,JSON.stringify(request)])).rows[0];
      let job=(await db.query('SELECT * FROM trend_alexandria_jobs WHERE run_id=$1',[run.id])).rows[0];
      if(!job){const budgetId=randomUUID();await db.query('INSERT INTO research_jobs(id) VALUES($1)',[budgetId]);
        job=(await db.query('INSERT INTO trend_alexandria_jobs(run_id,request_id,request_hash,budget_id) VALUES($1,$2,$3,$4) RETURNING *',[run.id,request_id,hash,budgetId])).rows[0];}
      await db.query('INSERT INTO trend_alexandria_requests(request_id,run_id,request_hash) VALUES($1,$2,$3)',[request_id,run.id,hash]);
      await db.query('COMMIT');return c.json({id:run.id,status:job.state,model,credit_limit:25,message:'รับคำขอแล้ว · ค้นเว็บก่อนตรวจโซเชียล · สูงสุด 25 เครดิต Firecrawl'},202);
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  });
  app.get('/app/api/studio/trends/runs/:id',guard,async c=>{
    const id=z.string().uuid().safeParse(c.req.param('id'));if(!id.success)return c.json({error:'not found'},404);
    const r=(await pool.query('SELECT r.*,j.budget_id,j.state AS status FROM trend_research_runs r JOIN trend_alexandria_jobs j ON j.run_id=r.id WHERE r.id=$1 OR r.id=(SELECT run_id FROM trend_alexandria_requests WHERE request_id=$1)',[id.data])).rows[0];
    if(!r)return c.json({error:'not found'},404);
    const trends=r.eligible_count>0?(await eligibleTrends(pool,'both',10,r.id)).map(publicTrend):[];
    return c.json({...await presentRun(r),trends});
  });
  app.post('/app/api/studio/trends/runs/:id/retry',guard,async c=>{
    const id=z.string().uuid().safeParse(c.req.param('id'));if(!id.success)return c.json({error:'not found'},404);
    const r=(await pool.query("UPDATE trend_alexandria_jobs SET state='queued',updated_at=now() WHERE run_id=$1 AND state='failed' RETURNING run_id",[id.data])).rows[0];
    return r?c.json({id:r.run_id,message:'ทำงานต่อจาก checkpoint และงบเดิม ไม่ส่งคำขอที่ผลไม่แน่นอนซ้ำ'},202):c.json({error:'งานนี้ยังทำต่อไม่ได้'},409);
  });
}
