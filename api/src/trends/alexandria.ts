import {createHash,randomUUID} from 'node:crypto';
import {ResearchBudgetError,type BudgetStore,type SafeRequest} from '../firecrawl-budget.js';

export const CATALOG_URL='https://docs.firecrawl.dev/features/alexandria';
export const REVIEWED_TOOLS=['tiktok/search-videos','tiktok/video','tiktok/video-comments','instagram/search-reels','instagram/post','instagram/post-comments','youtube/search','youtube/video','youtube/video-comments'];
export type Tool={provider:string;capability:string;description:string;creditsCost:number;perRecord:boolean;options:any[];response?:any;billing?:{maxCredits?:number};[key:string]:any};
export class AlexandriaError extends Error {constructor(readonly code:string,message:string,readonly actionUrl?:string){super(message);}}
const actionUrl=(x:any)=>{try{const u=new URL(x);return u.protocol==='https:'&&u.hostname==='www.firecrawl.dev'?u.href:undefined;}catch{return undefined;}};
function resultOf(payload:any,provider:string,capability:string) {
  const item=payload?.data?.alexandria?.find((x:any)=>x.provider===provider&&x.capability===capability);
  if(payload?.success!==true||!item||item.error||item.upstreamStatus>=400||item.data?.success===false){
    const err=item?.error||payload?.error;
    const code=typeof err==='object'?err?.code:payload?.code;
    throw new AlexandriaError(code||'provider_error',code==='THIRD_PARTY_DATA_TERMS_REQUIRED'?'Firecrawl requires the owner to accept this provider’s terms':'Alexandria returned no usable provider response',actionUrl(payload?.requiresAction?.url||err?.requiresAction?.url));
  }
  return item;
}
export class Alexandria {
  constructor(private options:{apiKey:string;fetch?:typeof fetch}){}
  /** Read-only account usage endpoint from the official v2 OpenAPI; no execution credits. */
  async credits(){
    const r=await (this.options.fetch||fetch)('https://api.firecrawl.dev/v2/team/credit-usage',{headers:{Authorization:'Bearer '+this.options.apiKey},signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw new AlexandriaError('credit_check_unavailable','Firecrawl credit balance HTTP '+r.status);
    const body:any=await r.json();if(body.success!==true||!Number.isFinite(body.data?.remainingCredits))throw new AlexandriaError('credit_check_unavailable','Firecrawl credit balance is unavailable');
    return {remaining_credits:body.data.remainingCredits,plan_credits:Number.isFinite(body.data.planCredits)?body.data.planCredits:null,checked_at:new Date().toISOString()};
  }
  private async post(body:any,id:string){
    return (this.options.fetch||fetch)('https://api.firecrawl.dev/v2/scrape',{method:'POST',headers:{Authorization:'Bearer '+this.options.apiKey,'Content-Type':'application/json','x-request-id':id},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  }
  /** Official free discovery only. Retries are permitted here because this never executes a paid tool. */
  async discover(provider:string):Promise<Tool[]> {
    if(!['scrapecreators','oriane'].includes(provider))throw new AlexandriaError('unsupported_provider','Provider has not been reviewed');
    const tools:Tool[]=[];
    for(let offset=0;offset<200;offset+=50){
      let payload:any;
      for(let attempt=0;attempt<2;attempt++){
        try{
          const r=await this.post({alexandria:{provider:'firecrawl',capability:'find-tools',options:{providers:[provider],level:'tools',expand:['options','response'],limit:50,offset}}},randomUUID());
          payload=await r.json();
          if(!r.ok)throw new AlexandriaError('discovery_http_'+r.status,'Alexandria catalogue HTTP '+r.status);
          break;
        }catch(e){if(attempt===1||e instanceof AlexandriaError&&!/429|50[234]/.test(e.code))throw e;}
      }
      const item=resultOf(payload,'firecrawl','find-tools');
      if(item.creditsCost!==0)throw new AlexandriaError('discovery_cost_changed','Free discovery contract changed; execution stopped');
      if(!Array.isArray(item.data?.items))throw new AlexandriaError('catalog_contract','Invalid Alexandria catalogue');
      for(const t of item.data.items){
        const p=typeof t.provider==='string'?t.provider:t.execute?.provider;
        const c=t.capability||t.execute?.capability;
        if(p===provider&&typeof c==='string')tools.push({...t,provider:p,capability:c});
      }
      if(!item.data.next||offset+50>=item.data.total)break;
    }
    return tools;
  }
  async execute(store:BudgetStore,job:string,tool:Tool,options:Record<string,unknown>,webAttempted:boolean){
    if(!webAttempted)throw new ResearchBudgetError('web_first','OpenAI Web Search must run before social data retrieval');
    const req=pricedTool(tool,options);
    return store.exclusive(job,async()=>{
      const initial=await store.snapshot(job);
      if(initial.limit!==25)throw new ResearchBudgetError('budget_configuration','Trend Research Jobs require a hard limit of 25 credits');
      const cached=await store.cached(req.key);
      if(cached)return {data:resultOf(cached.payload,tool.provider,tool.capability).data,cache_hit:true,collected_at:cached.collected_at,credits:0,budget:initial};
      const id=await store.reserve(job,req);
      let payload:any,response:Response;
      try{response=await this.post(req.body,id);payload=await response.json();}
      catch{await store.finish(job,id,req,null,'Ambiguous provider outcome; maximum retained, no paid retry',true);throw new AlexandriaError('uncertain_charge','Provider response interrupted; further calls stopped to prevent duplicate charges');}
      let item:any;
      try{if(!response.ok){resultOf(payload,tool.provider,tool.capability);throw new AlexandriaError('provider_http_'+response.status,'Alexandria HTTP '+response.status);}item=resultOf(payload,tool.provider,tool.capability);}
      catch(e){
        const failed=payload?.data?.alexandria?.find((x:any)=>x.provider===tool.provider&&x.capability===tool.capability);
        const confirmedFree=failed?.error&&failed.creditsCost===0;
        await store.finish(job,id,req,confirmedFree?{creditsUsed:0}:null,e instanceof AlexandriaError?e.code:'provider_error',response.status>=500);throw e;
      }
      // The documented per-result creditsCost is the actual Firecrawl charge, never vendor credits_charged.
      const actual=Number.isSafeInteger(item.creditsCost)&&item.creditsCost>=0?item.creditsCost:null;
      const stored={...payload,creditsUsed:actual};
      await store.finish(job,id,req,stored);
      const budget=await store.snapshot(job);
      if(budget.blocked_reason)throw new AlexandriaError('cost_mismatch','Provider charge exceeded its discovered maximum; job stopped');
      return {data:item.data,cache_hit:false,collected_at:new Date().toISOString(),credits:actual,budget};
    });
  }
}
export function pricedTool(tool:Tool,options:Record<string,unknown>):SafeRequest {
  // Reviewed against official catalogue on 2026-11-15. A runtime price change closes the gate.
  if(tool.provider!=='scrapecreators'||!REVIEWED_TOOLS.includes(tool.capability)||tool.perRecord!==false||tool.creditsCost!==2||tool.billing?.maxCredits!==2)
    throw new ResearchBudgetError('uncertain_cost','This capability has no reviewed maximum that fits the 25-credit job');
  if(!Array.isArray(tool.options))throw new ResearchBudgetError('capability_contract','Missing provider input contract');
  if(options.include_replies===true||options.includeReplies===true)throw new ResearchBudgetError('uncertain_cost','Expanded comment replies have no approved maximum');
  for(const key of Object.keys(options))if(!tool.options.some(o=>o.name===key))throw new ResearchBudgetError('capability_options','Unsupported provider option: '+key);
  for(const o of tool.options){const v=options[o.name];if(v==null){if(o.required)throw new ResearchBudgetError('capability_options','Required provider option: '+o.name);continue;}
    if(typeof v!==o.type&&!(o.type==='integer'&&Number.isSafeInteger(v)))throw new ResearchBudgetError('capability_options','Provider input type changed: '+o.name);
    if(Array.isArray(o.oneOf)&&!o.oneOf.includes(v))throw new ResearchBudgetError('capability_options','Unsupported provider option value');
  }
  const body={alexandria:{provider:tool.provider,capability:tool.capability,options}};
  return {path:'/v2/scrape',body,maximum:2,urls:typeof options.url==='string'?[options.url]:[],key:createHash('sha256').update('alexandria-v1:'+JSON.stringify(body)).digest('hex')};
}
export async function verifyResearchModel(model:string,request:typeof fetch=fetch){
  if(!/^[a-zA-Z0-9._-]+$/.test(model))throw new Error('TREND_RESEARCH_MODEL must be configured');
  const r=await request((process.env.OPENAI_BASE_URL||'https://api.openai.com').replace(/\/$/,'')+'/v1/models/'+encodeURIComponent(model),{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error('Configured research model is unavailable: HTTP '+r.status);
  const data:any=await r.json();if(data.id!==model)throw new Error('Research model identity mismatch');return {id:data.id,verified_at:new Date().toISOString()};
}
