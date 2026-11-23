import {OpenAIReadUnavailable,openaiResponse} from '../openai-response.js';
import type {Queryable} from './store.js';
export function estimateTerra(usage:any) {
  if(!usage||![usage.input_tokens,usage.output_tokens].every(x=>Number.isSafeInteger(x)&&x>=0))return null;
  const input=Number(usage.input_tokens)||0,output=Number(usage.output_tokens)||0,cached=Number(usage.input_tokens_details?.cached_tokens)||0;
  const write=Number(usage.input_tokens_details?.cache_write_tokens??usage.input_tokens_details?.cache_creation_tokens)||0;
  if(![cached,write].every(x=>Number.isSafeInteger(x)&&x>=0)||cached+write>input)return null;
  // Standard Terra USD rates. Actual billing remains null until reconciled with invoices.
  return ((Math.max(0,input-cached-write))+(cached*.05)+(write*1.25)+output*5)/1e6;
}
export function outputJSON(response:any) {
  if(response.status!=='completed')throw new Error('OpenAI incomplete research response');
  return JSON.parse((response.output||[]).filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join(''));
}
export class ResearchResponsePending extends Error {
  constructor(readonly stage:string){super('Waiting for the saved OpenAI response');}
}
type ResearchRetry={at?:string;response_id?:string;replace_cancelled?:boolean};
const pollingWindow=30*60_000;

export async function researchResponse(db:Queryable,runId:string,stage:string,body:any,deadline:number,model=process.env.TREND_RESEARCH_MODEL||'gpt-6.1-terra',retry:ResearchRetry={}) {
  const initialKey=runId+':'+stage,repairKey=initialKey+':after_cancel';
  const {rows}=await db.query('SELECT * FROM trend_provider_calls WHERE call_key IN ($1,$2)',[initialKey,repairKey]);
  const saved=rows.find(row=>row.call_key===repairKey)??rows[0];

  async function attempt(callKey:string,existing?:any) {
    if(existing && existing.model!==model)throw new Error('Saved research model differs from this request');
    const cached=existing?.api_usage?.response;
    if(cached?.id && cached.id===existing.response_id && ['completed','incomplete','cancelled','failed'].includes(cached.status)){
      if(cached.status==='completed' && existing.status!=='done')await db.query("UPDATE trend_provider_calls SET status='done',error=NULL WHERE call_key=$1",[callKey]);
      return cached;
    }
    if(existing && !existing.response_id)throw new Error('Ambiguous provider create: refusing duplicate paid request');
    let createdAt=existing?.created_at;
    if(!existing){
      if(!body)throw new Error('ไม่พบคำขอ OpenAI ที่บันทึกไว้สำหรับตรวจสถานะ');
      const reserved=.12,limit=Math.max(.12,Math.min(10,Number(process.env.TREND_DAILY_BUDGET_USD)||2));
      const daily=Number((await db.query("SELECT COALESCE(sum(GREATEST(COALESCE(estimated_usd,0),reserved_usd)),0) AS total FROM trend_provider_calls WHERE created_at>now()-interval '24 hours' AND research_run_id IS NOT NULL")).rows[0].total);
      if(daily+reserved>limit)throw new Error('Research daily cost budget reached');
      if(deadline-Date.now()<10000)throw new Error('Research deadline reached');
      const inserted=await db.query('INSERT INTO trend_provider_calls(research_run_id,call_key,model,reserved_usd) VALUES($1,$2,$3,$4) ON CONFLICT(call_key) DO NOTHING RETURNING created_at',[runId,callKey,model,reserved]);
      if(!inserted.rows.length)throw new ResearchResponsePending(stage);
      createdAt=inserted.rows[0].created_at;
    }
    function waitForNextRead():never {
      const since=Math.max(new Date(createdAt).getTime(),Date.parse(retry.at??'')||0);
      if(Date.now()-since>=pollingWindow)throw new Error('รอผล OpenAI ครบ 30 นาทีแล้ว กดตรวจคำขอเดิมเพื่อติดตามต่อ');
      throw new ResearchResponsePending(stage);
    }
    try{
      let response;
      try{
        response=await openaiResponse(body?{...body,model,reasoning:{effort:'low'},max_output_tokens:Math.min(body.max_output_tokens||2000,6000)}:{},{
          apiKey:process.env.OPENAI_API_KEY!,baseUrl:process.env.OPENAI_BASE_URL||'https://api.openai.com',pollOnce:true,timeoutMs:30000,responseId:existing?.response_id,
        });
      }catch(error){if(error instanceof OpenAIReadUnavailable && existing?.response_id)waitForNextRead();throw error;}
      if(['queued','in_progress'].includes(response.status)){
        if(!existing?.response_id || existing.status!=='started')await db.query("UPDATE trend_provider_calls SET response_id=$2,status='started',error=NULL,finished_at=NULL WHERE call_key=$1",[callKey,response.id]);
        waitForNextRead();
      }
      const searches=(response.output||[]).filter((x:any)=>x.type==='web_search_call').length;
      const tokens=model==='gpt-6.1-terra'?estimateTerra(response.usage):null;
      const estimated=tokens==null?null:tokens+searches*.01;
      await db.query(`UPDATE trend_provider_calls SET status=$2,response_id=$3,usage=$4,estimated_usd=$5,reserved_usd=COALESCE($5,reserved_usd),
        api_usage=api_usage || $6::jsonb,finished_at=now(),error=NULL WHERE call_key=$1`,
        [callKey,response.status==='completed'?'done':'failed',response.id,JSON.stringify(response.usage??null),estimated,
          JSON.stringify({response,provider_status:response.status,reconciled_at:new Date().toISOString(),web_search_calls:searches})]);
      return response;
    }catch(error){
      if(!(error instanceof ResearchResponsePending))await db.query("UPDATE trend_provider_calls SET status='failed',error=$2,finished_at=now() WHERE call_key=$1",[callKey,error instanceof Error?error.message.slice(0,500):'provider failure']);
      throw error;
    }
  }

  let response=await attempt(saved?.call_key??initialKey,saved);
  if(response.status==='cancelled' && saved?.call_key===initialKey && retry.replace_cancelled && retry.response_id===saved.response_id){
    // A read-only poll has no request body. The orchestrator reconstructs the stage from its checkpoint.
    if(!body)return null;
    response=await attempt(repairKey);
  }
  if(response.status==='cancelled')throw new Error('OpenAI ยืนยันว่าคำขอนี้ถูกยกเลิกแล้ว');
  if(response.status!=='completed')throw new Error('OpenAI '+response.status+': '+(response.incomplete_details?.reason||response.error?.code||'response_failed'));
  return response;
}

/** Reconcile accepted failed/cancelled responses with reads, never another create. */
export async function reconcileUsage(db:Queryable,request:typeof fetch=fetch){
  // Repair reservations reconciled by previous deployments, using known usage only.
  await db.query(`UPDATE trend_provider_calls SET reserved_usd=estimated_usd
    WHERE api_usage ? 'reconciled_at' AND estimated_usd IS NOT NULL AND reserved_usd<>estimated_usd
      AND jsonb_typeof(usage->'input_tokens')='number' AND jsonb_typeof(usage->'output_tokens')='number'`);
  const rows=(await db.query(`SELECT c.*,COALESCE(c.response_id,t.response_id) AS saved_response_id FROM trend_provider_calls c LEFT JOIN topic_suggestions t ON t.id=c.topic_suggestion_id
    WHERE (c.status='failed' OR (c.status='started' AND t.status IN ('failed','done')))
      AND NOT(c.api_usage ? 'reconciled_at') AND COALESCE((c.api_usage->>'reconciliation_attempts')::int,0)<3
      AND COALESCE(c.response_id,t.response_id) IS NOT NULL ORDER BY c.created_at LIMIT 4`)).rows;
  const results=[];
  for(const row of rows){
    if(!/^resp_[a-zA-Z0-9_-]+$/.test(row.saved_response_id))continue;
    row.api_usage={...row.api_usage,reconciliation_attempts:Number(row.api_usage.reconciliation_attempts||0)+1};
    await db.query('UPDATE trend_provider_calls SET api_usage=$2 WHERE id=$1',[row.id,JSON.stringify(row.api_usage)]);
    const r=await request((process.env.OPENAI_BASE_URL||'https://api.openai.com').replace(/\/$/,'')+'/v1/responses/'+row.saved_response_id,{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(20000)});
    if(!r.ok)continue;
    const response:any=await r.json();if(['queued','in_progress'].includes(response.status))continue;
    const searches=(response.output||[]).filter((x:any)=>x.type==='web_search_call').length;
    const tokens=row.model==='gpt-6.1-terra'?estimateTerra(response.usage):null;
    const estimated=tokens==null?null:tokens+searches*.01;
    await db.query("UPDATE trend_provider_calls SET status=CASE WHEN status='started' THEN $6 ELSE status END,response_id=$2,usage=$3,estimated_usd=$4,reserved_usd=COALESCE($4,reserved_usd),api_usage=$5,finished_at=COALESCE(finished_at,now()) WHERE id=$1",[row.id,row.saved_response_id,JSON.stringify(response.usage||null),estimated,JSON.stringify({...row.api_usage,reconciled_at:new Date().toISOString(),provider_status:response.status,response,web_search_calls:searches}),response.status==='completed'?'done':'failed']);
    results.push({id:row.id,status:response.status,usage:response.usage||null,estimated_usd:estimated});
  }
  return results;
}
