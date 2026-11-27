import type {Context, Hono, Next} from 'hono';
import type pg from 'pg';
import {IS_STUDIO_DRAFT} from './studio-draft-queries.js';

const restartErrors = new Set([
  'ระบบรีสตาร์ทระหว่างเขียน กด "เขียนใหม่" เพื่อเริ่มอีกครั้ง',
  'ระบบรีสตาร์ทระหว่างเขียน ยังไม่มีจุดบันทึกรอบที่ยืนยันคำขอเดิมได้',
]);
const accepted = /^OpenAI รับงานแล้ว กำลังประมวลผลเบื้องหลัง \[(resp_[a-zA-Z0-9_-]+)\]$/;
const round = /^รอบที่ (\d+): /;

// The legacy writer awaited saveUsage(turns=N) before starting *any* tool of
// round N. A failed write short-circuited the loop. Only N-1 persisted rounds
// and this uninterrupted main-response receipt prove no nested tool was sent.
export function legacyPlannerReceipt(row:any) {
  if (!row || row.removed_at || row.status !== 'failed' || !restartErrors.has(row.error) ||
      row.planner_checkpoint || row.job_id || row.draft || row.storyboard || !Array.isArray(row.log)) return null;
  const messages = row.log.map((entry:any) => String(entry?.msg || ''));
  let last = messages.length - 1;
  while (last >= 0 && /^OpenAI ยังประมวลผลอยู่ \(/.test(messages[last])) last--;
  const response = accepted.exec(messages[last] || '');
  const marker = messages[last-1] || '';
  const n = Number(round.exec(marker)?.[1]);
  if (!response || !Number.isSafeInteger(n) || n < 1 ||
      marker !== `รอบที่ ${n}: ค้นข้อมูล/วางบท (${row.model})` ||
      (row.usage?.turns ?? 0) !== n - 1) return null;
  const rounds = messages.filter((msg:string) => round.test(msg));
  if (rounds.length !== n || rounds.some((msg:string,i:number) => Number(round.exec(msg)?.[1]) !== i+1)) return null;
  return {turn:n, response_id:response[1]};
}

export function needsFreshPlannerConsent(row:any): boolean {
  if (row.status !== 'failed') return false;
  if (restartErrors.has(row.error)) return !legacyPlannerReceipt(row);
  // A committed reservation with no receipt might already have reached the provider.
  const wait=row.planner_checkpoint?.wait;
  if (wait?.state==='uncertain' || wait?.state==='blocked') return true;
  return Object.entries(row.planner_checkpoint?.calls ?? {}).some(([key,call]:[string,any]) =>
    !call?.response_id && !call?.result && !(wait?.key===key && wait.state==='failed'));
}

type Dependencies = {
  guard:(c:Context, next:Next)=>Promise<any>;
  readResponse:(id:string)=>Promise<any>;
  wake:()=>void;
};

export function registerLegacyPlannerResume(app:Hono,pool:pg.Pool,deps:Dependencies) {
  const path = '/app/api/studio/drafts/:id/resume';
  const read = async (id:string) => (await pool.query(`SELECT status,error,model,usage,log,job_id,
      draft IS NOT NULL AS draft, storyboard IS NOT NULL AS storyboard,
      planner_checkpoint IS NOT NULL AS planner_checkpoint, xmin::text AS version
      FROM drafts WHERE id=$1 AND removed_at IS NULL AND ${IS_STUDIO_DRAFT}`,[id])).rows[0];

  async function handle(c:Context) {
    const id = c.req.param('id');
    if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return c.json({error:'ไม่พบร่างนี้'},404);
    const row = await read(id);
    if (!row) return c.json({error:'ไม่พบร่างนี้'},404);
    const submit = c.req.method === 'POST';
    const body = submit ? await c.req.json().catch(()=>null) : null;
    if (submit && (body?.confirm !== true || typeof body.response_id !== 'string')) return c.json({error:'กรุณายืนยันการทำร่างเดิมต่อ'},422);
    const alreadyQueued = (r:any) => !!r?.log?.some((entry:any)=>entry.resume_response_id===body?.response_id && typeof entry.resume_response_id==='string');
    if (submit && alreadyQueued(row)) return c.json({id,duplicate:true,status:row.status});
    const receipt = legacyPlannerReceipt(row);
    if (!receipt || (submit && body.response_id !== receipt.response_id)) return c.json({error:'ยืนยันจุดที่ร่างหยุดไม่ได้ กรุณาตรวจสถานะร่างอีกครั้ง'},409);
    // Only retrieve the exact server-recorded response. Verify the original tool
    // definitions as well, since nested search also logged an OpenAI response ID.
    let response:any;
    try { response=await deps.readResponse(receipt.response_id); }
    catch { return c.json({error:'ยังอ่านคำตอบเดิมจาก OpenAI ไม่ได้ กรุณาลองอีกครั้ง'},503); }
    if (response.id!==receipt.response_id || !['completed','incomplete','in_progress','queued'].includes(response.status) ||
        !Array.isArray(response.tools) || !response.tools.some((tool:any)=>tool.type==='function' && tool.name==='plan_story')) {
      return c.json({error:'OpenAI ไม่มีคำตอบวางบทเดิมที่นำมาทำต่อได้'},409);
    }
    if (!submit) return c.json({id,...receipt,provider_status:response.status});
    const checkpoint = {version:1,provider:'openai',legacy:true,turn:receipt.turn-1,calls:{main:{response_id:receipt.response_id}}};
    const event = {at:new Date().toISOString(),msg:'ยืนยันทำร่างเดิมต่อจากคำตอบ OpenAI ที่บันทึกไว้',resume_response_id:receipt.response_id};
    const updated = await pool.query(`UPDATE drafts SET planner_checkpoint=$2::jsonb,status='queued',error=NULL,
      auto_produce=false,log=log||$3::jsonb,updated_at=now()
      WHERE id=$1 AND xmin::text=$4 AND status='failed' AND planner_checkpoint IS NULL AND removed_at IS NULL RETURNING id`,
      [id,JSON.stringify(checkpoint),JSON.stringify([event]),row.version]);
    if (!updated.rows.length) {
      const fresh = await read(id);
      if (alreadyQueued(fresh)) return c.json({id,duplicate:true,status:fresh.status});
      return c.json({error:'ร่างเปลี่ยนระหว่างตรวจ กรุณาเปิดร่างอีกครั้ง'},409);
    }
    deps.wake();
    return c.json({id,status:'queued'},202);
  }
  app.get(path,deps.guard,handle);
  app.post(path,deps.guard,handle);
}
