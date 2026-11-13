import {readFileSync} from 'node:fs';
import {money,type Rate} from './text-video-contract.js';
import type {ShotPlanT} from './reverse-contract.js';
const catalog=JSON.parse(readFileSync(new URL('../config/reverse-fal-catalog.json',import.meta.url),'utf8'));
// Published promotion deadlines are optional; every maintained price still has
// a bounded freshness window from its recorded verification time.
const validUntil=(m:any)=>new Date(Math.min(Date.parse(m.price_checked_at||catalog.checked_at)+24*3600000,m.price_valid_until?Date.parse(m.price_valid_until):Infinity)).toISOString();
function cost(m:any,seconds:number){const p=m.pricing||{};if(p.unit==='duration_table'){const v=p.usd_by_duration?.[String(seconds)];return v==null?null:money(Number(v));}let units:number;if(p.unit==='video_second')units=seconds;else if(p.unit==='video')units=1;else if(p.unit==='1000_video_tokens')units=p.width*p.height*p.fps*seconds/p.token_divisor/1000;else return null;const value=Number(p.usd_per_unit)*units;return Number.isFinite(value)&&value>=0?money(value):null;}
export function catalogModels(target=5){return catalog.models.map((m:any)=>{const option=m.preset?.duration_options?.find((x:any)=>x.seconds>=target),estimate=option?cost(m,option.seconds):null;const reasons=[...(m.availability_blockers||[])];if(!m.preset)reasons.push('ยังไม่มีค่าตั้งที่ตรวจ schema');if(Date.parse(validUntil(m))<=Date.now())reasons.push('ต้องตรวจราคาปัจจุบันใหม่');if(!(m.preset?.duration_options||[]).some((o:any)=>cost(m,o.seconds)!==null))reasons.push('ยังไม่มีสูตรราคาที่ตรวจสอบได้');return{id:m.id,label:m.label,endpoint_id:m.endpoint_id,estimate_usd:estimate,duration_costs:(m.preset?.duration_options||[]).map((x:any)=>({duration_s:x.seconds,usd:cost(m,x.seconds)})),available:!reasons.length,reasons,preset_resolution:m.preset_resolution,durations:m.durations,price_valid_until:validUntil(m),price_source:m.price_source};}).sort((a:any,b:any)=>Number(!a.available)-Number(!b.available)||(a.estimate_usd??Infinity)-(b.estimate_usd??Infinity)||a.label.localeCompare(b.label));}
export function catalogTask(shot:ShotPlanT,measured:any,rates:Rate[]){
  const m=catalog.models.find((x:any)=>x.id===shot.model||x.endpoint_id===shot.model);if(!m)throw Error('Model is absent from the verified fal catalog');
  if(!shot.human_reviewed)throw Error('Review the exact prompt before generation');
  if(shot.references.length||shot.handoff_previous_frame)throw Error('Catalog route is text-to-video; use verified H3/Grok I2V for approved images');
  const visible=catalogModels(measured.duration_s).find((x:any)=>x.id===m.id);if(!visible?.available)throw Error(visible?.reasons.join('; ')||'Model blocked');
  if(shot.settings.aspect_ratio&&shot.settings.aspect_ratio!=='9:16')throw Error('This maintained preset is verified for 9:16; select a verified H3/Grok adapter for other formats');
  if(shot.settings.resolution&&shot.settings.resolution!==m.preset_resolution)throw Error('Select the displayed verified preset resolution for this model');
  const o=m.preset.duration_options.find((x:any)=>x.seconds>=measured.duration_s);if(!o)throw Error('Shot exceeds the verified duration range; split it explicitly');const payload={...m.preset.defaults,...o.input,prompt:shot.prompt};
  if(shot.prompt.length>m.max_prompt_length)throw Error('Prompt exceeds the selected model limit');
  const rate=rates.find(r=>r.endpoint_id===m.endpoint_id);if(!rate||rate.currency!=='USD'||!Number.isFinite(rate.unit_price)||rate.unit_price<=0)throw Error('Current fal price unavailable');
  return {provider:'fal',endpoint:m.endpoint_id,model:m.endpoint_id,category:'video',usd:cost(m,o.seconds),payload,rate,measured,shot,references:[],model_schema:m.preset.schema,pricing_source:m.price_source,pricing_valid_until:validUntil(m),model_contract_hash:m.contract_hash,pricing_note:m.pricing_note};
}
