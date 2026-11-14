import type {Hono,Context,Next} from 'hono';
import type pg from 'pg';
import {z} from 'zod';
import {eligibleTrends,publicTrend} from './store.js';
export const trendSettings=()=>({enabled:process.env.MOTION_TREND_RESEARCH_ENABLED==='1',verified_platforms:(process.env.TREND_VERIFIED_PLATFORMS||'').split(',').filter(x=>['tiktok','instagram'].includes(x)),window_days:7,refresh_hours:6,minimum_score:Number(process.env.TREND_MIN_SCORE)||70,timezone:'Asia/Bangkok'});
export function registerTrendRoutes(app:Hono,pool:pg.Pool,guard:(c:Context,next:Next)=>Promise<any>){
  app.get('/app/api/studio/trends',guard,async c=>{
    const platform=['tiktok','instagram'].includes(c.req.query('platform')||'')?c.req.query('platform')!:'both';
    const settings=trendSettings();
    const runs=(await pool.query('SELECT id,status,request,created_at,finished_at,error,browser_actions,duration_ms,evidence_count,eligible_count FROM trend_research_runs ORDER BY created_at DESC LIMIT 8')).rows;
    return c.json({...settings,trends:settings.enabled?(await eligibleTrends(pool,platform)).map(publicTrend):[],runs});
  });
  app.post('/app/api/studio/trends/refresh',guard,async c=>{
    const input=z.object({request_id:z.string().uuid(),platform:z.enum(['tiktok','instagram','both']).default('both')}).safeParse(await c.req.json().catch(()=>null));
    if(!input.success)return c.json({error:'ข้อมูลคำขอค้นหาเทรนด์ไม่ถูกต้อง'},422);
    const settings=trendSettings();if(!settings.enabled)return c.json({error:'ระบบค้นหาเทรนด์ยังไม่เปิดใช้งาน โหมด Creative ใช้งานได้ตามปกติ'},503);
    const platforms=settings.verified_platforms.filter(p=>input.data.platform==='both'||p===input.data.platform);
    if(!platforms.length)return c.json({error:'แพลตฟอร์มนี้ยังไม่ผ่านการตรวจการเข้าถึงจริง'},503);
    const ids=[];
    // A ten-minute platform slot is shared across clicks, tabs and API replicas.
    for(const platform of platforms){
      const key=`manual:${platform}:${Math.floor(Date.now()/600000)}`;
      const row=(await pool.query('INSERT INTO trend_research_runs(request_key,request) VALUES($1,$2) ON CONFLICT(request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING id,status',[key,JSON.stringify({platform,query:process.env.TREND_DEFAULT_QUERY||'วิทยาศาสตร์ เรื่องใกล้ตัว เทคโนโลยี ไทย',limit:3,owner_request:input.data.request_id})])).rows[0];ids.push(row);
    }
    return c.json({runs:ids,message:'รับคำขอแล้ว ผลที่ผ่านการตรวจจะใช้ในหัวข้อชุดถัดไป'},202);
  });
}
