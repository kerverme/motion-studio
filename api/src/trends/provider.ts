import {openaiResponse} from '../openai-response.js';
import type {Queryable} from './store.js';
export function estimateTerra(usage:any) {
  if(!usage)return null;
  const input=Number(usage.input_tokens)||0,output=Number(usage.output_tokens)||0,cached=Number(usage.input_tokens_details?.cached_tokens)||0;
  const write=Number(usage.input_tokens_details?.cache_creation_tokens)||0;
  // Standard Terra USD rates. Actual billing remains null until reconciled with invoices.
  return ((Math.max(0,input-cached-write))+(cached*.05)+(write*1.25)+output*5)/1e6;
}
export function outputJSON(response:any) {
  if(response.status!=='completed')throw new Error('OpenAI incomplete research response');
  return JSON.parse((response.output||[]).filter((x:any)=>x.type==='message').flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join(''));
}
export async function researchResponse(db:Queryable,runId:string,key:string,body:any,deadline:number) {
  const callKey=runId+':'+key,model='gpt-6.1-terra';
  // Reserve a conservative per-call upper bound, including possible web-search fees.
  const reserved=.12,limit=Math.max(.12,Math.min(10,Number(process.env.TREND_DAILY_BUDGET_USD)||2));
  const existing=(await db.query('SELECT * FROM trend_provider_calls WHERE call_key=$1',[callKey])).rows[0];
  if(existing?.status==='done')return existing.api_usage.response;
  if(existing&&!existing.response_id)throw new Error('Ambiguous provider create; refusing duplicate paid request');
  if(!existing){
    const daily=Number((await db.query("SELECT COALESCE(sum(GREATEST(COALESCE(estimated_usd,0),reserved_usd)),0) AS total FROM trend_provider_calls WHERE created_at>now()-interval '24 hours' AND research_run_id IS NOT NULL")).rows[0].total);
    if(daily+reserved>limit)throw new Error('Research daily cost budget reached');
    if(deadline-Date.now()<10000)throw new Error('Research deadline reached');
    await db.query('INSERT INTO trend_provider_calls(research_run_id,call_key,model,reserved_usd) VALUES($1,$2,$3,$4)',[runId,callKey,model,reserved]);
  }
  try {
    const response=await openaiResponse({...body,model,reasoning:{effort:'low'},max_output_tokens:Math.min(body.max_output_tokens||2000,4000)},{apiKey:process.env.OPENAI_API_KEY!,baseUrl:process.env.OPENAI_BASE_URL||'https://api.openai.com',timeoutMs:Math.max(1,Math.min(300000,deadline-Date.now())),responseId:existing?.response_id,
      onProgress:async message=>{const id=message.match(/\[(resp_[\w-]+)\]/)?.[1];if(id)await db.query('UPDATE trend_provider_calls SET response_id=$2 WHERE call_key=$1',[callKey,id]);}});
    const searches=(response.output||[]).filter((x:any)=>x.type==='web_search_call').length;
    await db.query("UPDATE trend_provider_calls SET status='done',response_id=$2,usage=$3,estimated_usd=$4,reserved_usd=$4,api_usage=$5,finished_at=now() WHERE call_key=$1",[callKey,response.id,JSON.stringify(response.usage||null),(estimateTerra(response.usage)??reserved)+searches*.01,JSON.stringify({response,web_search_calls:searches})]);
    return response;
  }catch(error){await db.query("UPDATE trend_provider_calls SET status='failed',error=$2,finished_at=now() WHERE call_key=$1",[callKey,error instanceof Error?error.message.slice(0,500):'provider failure']);throw error;}
}
