import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export type VideoCategory='text-to-video'|'image-to-video'|'video-to-video'|'video-editing';
type Obj=Record<string,any>;
export type FalVideoModel={
  endpoint_id:string; category:VideoCategory; name:string; available:boolean; endpoint_available?:boolean;
  resolutions:string[]; durations:number[]; audio:boolean|null; input_schema:Obj; schema_hash:string;
  price:{unit:string;unit_price:number;currency:string}|null; source_url:string; checked_at:string; reason?:string;
  output_padding_seconds?:number;
  pricing_description?:string; billing?:Billing|null; verification_error?:string;
};
type Billing={rates:Record<string,number>;reference_image_usd?:number;source_second_usd?:number;basis?:'per_request'};
export const PREVIOUS_FRAME='https://studio.cloudbath.co/internal/previous-frame.png';
export const H3_MAX_IMAGE='minimax/h3-max/image-to-video';
const API='https://api.fal.ai/v1/models';
const schemaValidators=new Ajv2020({strict:false,allErrors:false,validateFormats:true,addUsedSchema:false});
addFormats(schemaValidators);
const safeEndpoint=/^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)+$/i;
const generation=['text-to-video','image-to-video'];

function validateEndpointId(endpoint:string){
  if(endpoint.length>230 || !safeEndpoint.test(endpoint))throw new Error('Invalid fal endpoint ID');
}
type RegistryStage='catalog'|'schema'|'documentation'|'pricing'|'estimate';
const stageName:Record<RegistryStage,string>={catalog:'รายการโมเดล',schema:'OpenAPI',documentation:'เอกสารรุ่น',pricing:'ราคาบัญชี',estimate:'ประมาณราคา'};
type RegistryFault='http'|'timeout'|'network'|'invalid'|'credentials'|'identity';
export class FalRegistryError extends Error {
  constructor(readonly stage:RegistryStage,readonly fault:RegistryFault,readonly status?:number) {
    const hint=fault==='http'?'HTTP '+status+(status===429?' · ถึงขีดจำกัดชั่วคราว':status===401||status===403?' · ตรวจสิทธิ์การเข้าถึง':''):
      ({timeout:'หมดเวลาตอบกลับ',network:'ติดต่อแหล่งข้อมูลไม่ได้',invalid:'คำตอบมีรูปแบบที่ตรวจไม่ได้',
        credentials:'ไม่มีข้อมูลบัญชีสำหรับตรวจราคา',identity:'เอกสารไม่ตรงกับ endpoint'} as const)[fault as Exclude<RegistryFault,'http'>];
    super('fal.ai · '+stageName[stage]+' · '+hint);
    this.name='FalRegistryError';
  }
}
// Only expose diagnostics generated locally. Provider bodies, request URLs and credentials stay out of logs and responses.
export function registryIssue(error:unknown):string{
  return error instanceof FalRegistryError?error.message:'fal.ai · ตรวจข้อมูลของรุ่นนี้ไม่สำเร็จ';
}
type Gate={tail:Promise<unknown>;next:number};
const gates=new WeakMap<typeof fetch,Map<string,Gate>>();
const delay=(ms:number)=>new Promise<void>(finish=>setTimeout(finish,ms));
function retryDelay(value:string|null){
  if(value===null)return 2000;
  if(/^\d+(?:\.\d+)?$/.test(value))return Math.max(0,Number(value)*1000);
  const when=Date.parse(value);return Number.isFinite(when)?Math.max(0,when-Date.now()):2000;
}
async function read(url:URL|string,request:typeof fetch,stage:RegistryStage,init:RequestInit={},allowMissing=false){
  const target=new URL(url);
  const official=target.origin==='https://api.fal.ai';
  const headers=new Headers(init.headers);
  if(official && process.env.FAL_KEY)headers.set('authorization','Key '+process.env.FAL_KEY);
  else headers.delete('authorization');
  const send=async()=>{
    try{return await request(target,{...init,headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});}
    catch(e){
      const name=e instanceof Error?e.name:'';
      throw new FalRegistryError(stage,name==='TimeoutError'||name==='AbortError'?'timeout':'network');
    }
  };
  let r:Response;
  if(official){
    // Only read-only Platform API operations reach here. Queue delivery and media generation use a separate service.
    let buckets=gates.get(request);if(!buckets){buckets=new Map();gates.set(request,buckets);}
    const bucket=(stage==='schema'||stage==='catalog')?'catalog':'pricing';
    let gate=buckets.get(bucket);if(!gate){gate={tail:Promise.resolve(),next:0};buckets.set(bucket,gate);}
    const slot=gate;
    const task=slot.tail.then(async()=>{
      for(let attempt=0;;attempt++){
        const wait=Math.max(0,slot.next-Date.now());
        if(wait>35_000)throw new FalRegistryError(stage,'http',429);
        if(wait)await delay(wait);
        slot.next=Date.now()+(bucket==='catalog'?500:100);
        const response=await send();
        if(response.status!==429)return response;
        const retry=retryDelay(response.headers.get('retry-after'));
        slot.next=Math.max(slot.next,Date.now()+retry);
        if(attempt||retry>35_000)return response;
        await response.body?.cancel().catch(()=>{});
      }
    });
    slot.tail=task.then(()=>{},()=>{});
    r=await task;
  }else r=await send();
  if(r.status===404 && allowMissing)throw new MissingEndpoint('fal catalog endpoint not found');
  if(!r.ok)throw new FalRegistryError(stage,'http',r.status);
  return r;
}
async function readJson(url:URL|string,request:typeof fetch,stage:RegistryStage,init:RequestInit={},allowMissing=false){
  const res=await read(url,request,stage,init,allowMissing);
  try {return await res.json();}catch{throw new FalRegistryError(stage,'invalid');}
}
function auth(stage:RegistryStage='pricing'){
  if(!process.env.FAL_KEY)throw new FalRegistryError(stage,'credentials');
  return {authorization:'Key '+process.env.FAL_KEY,'content-type':'application/json'};
}
function classified(endpoint:string,meta:Obj):VideoCategory|null{
  // The official discovery category is primary-only. These exact multimodal routes document a video reference input.
  if(/^google\/gemini-omni-flash\/v1\.[12]\/reference-to-video$/.test(endpoint) && meta.category==='image-to-video')return 'video-to-video';
  if(meta.category==='video-editing')return 'video-editing';
  if(meta.category==='video-to-video')return /\/(?:edit|edit-video|video-editing)(?:\/|$)/i.test(endpoint)?'video-editing':'video-to-video';
  return generation.includes(meta.category)?meta.category:null;
}
function canonicalName(name:string){
  return name.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
// These are name/version aliases only. Every endpoint is checked against today's official registry and category.
function knownAlias(name:string,cat:VideoCategory):string|null|undefined{
  const gen=generation.includes(cat);
  const edit=cat==='video-editing';
  const gemini=name.match(/^gemini omni (1 [12]) flash$/);
  if(gemini){
    const base='google/gemini-omni-flash/v'+gemini[1].replace(' ','.');
    return gen?base+'/'+cat:edit?base+'/edit':base+'/reference-to-video';
  }
  if(name==='gemini omni flash')return 'google/gemini-omni-flash'+(cat==='text-to-video'?'':cat==='image-to-video'?'/image-to-video':edit?'/edit':'/reference-to-video');
  if(name==='grok imagine video 1 5')return gen?'xai/grok-imagine-video/v1.5/'+cat:null;
  if(name==='grok imagine video')return gen?'xai/grok-imagine-video/'+cat:edit?'xai/grok-imagine-video/edit-video':null;
  const seed=name.match(/^dreamina seedance (2 [05])$/);
  if(seed)return gen?'bytedance/seedance-'+seed[1].replace(' ','.')+'/us/'+cat:null;
  if(name==='flux 3 video')return gen?'blackforestlabs/flux-3/'+cat:null;
  if(name==='wan 3 0')return gen?'alibaba/wan-3.0/'+cat:null;
  if(name==='minimax h3')return gen?'minimax/h3/'+cat:null;
  if(name==='kling o3 pro')return 'fal-ai/kling-video/o3/pro/'+(edit?'video-to-video/edit':cat==='video-to-video'?'video-to-video/reference':cat);
  return undefined;
}
class MissingEndpoint extends Error {}
type PriceLookup=(endpoint:string)=>Promise<Obj|null>;
type CatalogScope={exact:(endpoint:string)=>Promise<Obj|null>;search:(label:string)=>Promise<Obj>};
function searchCatalog(label:string,request:typeof fetch,category?:VideoCategory){
  const url=new URL(API);url.searchParams.set('q',label);url.searchParams.set('limit','100');
  if(category)url.searchParams.set('category',category==='video-editing'?'video-to-video':category);
  return readJson(url,request,'catalog');
}
async function catalogGroup(ids:string[],request:typeof fetch):Promise<Map<string,Obj>>{
  const url=new URL(API);
  // Official catalog accepts at most ten expanded OpenAPI documents and repeated endpoint_id filters.
  for(const id of ids){validateEndpointId(id);url.searchParams.append('endpoint_id',id);}
  url.searchParams.set('expand','openapi-3.0');url.searchParams.set('limit',String(ids.length));
  let result;
  try{result=await readJson(url,request,'schema',{},true);}
  catch(e){
    if(!(e instanceof MissingEndpoint))throw e;
    if(ids.length===1)return new Map();
    // fal returns a single 404 for a batch containing one removed ID. Isolate it without remapping any version.
    const half=Math.ceil(ids.length/2),first=await catalogGroup(ids.slice(0,half),request);
    const rest=await catalogGroup(ids.slice(half),request);
    return new Map([...first,...rest]);
  }
  if(!Array.isArray(result?.models) || result.has_more===true)throw new FalRegistryError('schema','invalid');
  const out=new Map<string,Obj>();
  for(const m of result.models){
    if(!m || !ids.includes(m.endpoint_id)||out.has(m.endpoint_id))throw new FalRegistryError('schema','invalid');
    out.set(m.endpoint_id,m);
  }
  return out;
}
export async function discoverRankedModel(name:string,category:VideoCategory,request:typeof fetch=fetch,lookup?:PriceLookup,scope?:CatalogScope):Promise<FalVideoModel|null>{
  const qualified=name.trim().match(/^(.*?)\s*\((\d+p)\)$/i);
  const label=qualified?qualified[1]:name.trim();
  const normalized=canonicalName(label);
  let endpoint=knownAlias(normalized,category);
  if(endpoint===undefined){
    const catalog=await (scope?scope.search(label):searchCatalog(label,request,category));
    if(!Array.isArray(catalog?.models))throw new FalRegistryError('catalog','invalid');
    // A partial or ambiguous search cannot establish a unique identity.
    if(catalog.has_more)return null;
    const matches=catalog.models.filter((m:Obj)=>{
      const display=canonicalName(String(m.metadata?.display_name||'')).replace(/ (text to video|image to video|video to video|edit video)$/,'');
      return display===normalized && classified(String(m.endpoint_id),m.metadata||{})===category;
    });
    if(matches.length!==1)return null;
    endpoint=matches[0].endpoint_id as string;
  }
  if(!endpoint)return null;
  try{
    const model=await getVideoModel(endpoint,category,request,lookup,scope);
    if(qualified){
      model.resolutions=model.resolutions.filter(r=>r.toLowerCase()===qualified[2].toLowerCase());
      if(!model.resolutions.length){model.available=false; model.reason='endpoint ยังไม่รองรับความละเอียดที่ Arena ใช้จัดอันดับ';}
    }
    return model;
  }catch(e){if(e instanceof MissingEndpoint)return null;throw e;}
}
function resolveSchema(value:any,document:Obj,seen:Set<string>=new Set()):any{
  if(Array.isArray(value))return value.map(v=>resolveSchema(v,document,seen));
  if(!value || typeof value!=='object')return value;
  if(value.$ref){
    const ref=value.$ref;
    if(typeof ref!=='string'||!ref.startsWith('#/components/schemas/')||seen.has(ref))throw new Error('Unsupported fal schema reference');
    const target=ref.slice(2).split('/').reduce((o:any,k:string)=>o?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],document);
    if(!target)throw new Error('Missing fal schema reference');
    const {$ref,...rest}=value;
    const next=new Set(seen).add(ref);
    const resolved=resolveSchema(target,document,next);
    const siblings=resolveSchema(rest,document,seen);
    return Object.keys(siblings).length?{allOf:[resolved,siblings]}:resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveSchema(v,document,seen)]));
}
function inputSchema(model:Obj){
  const doc=model.openapi;
  // Some catalog IDs are provider aliases. fal publishes their canonical queue ID in the returned OpenAPI document.
  const id=doc?.info?.['x-fal-metadata']?.endpointId;
  const post=(doc?.paths?.['/'+model.endpoint_id]??doc?.paths?.['/'+id])?.post;
  const input=post?.requestBody?.content?.['application/json']?.schema;
  if(!input)throw new Error('fal schema has no verified generation operation');
  const schema=resolveSchema(input,doc);
  if(!schema.properties || (schema.type && schema.type!=='object'))throw new Error('Unsupported fal generation schema');
  return schema as Obj;
}
function resultSchema(model:Obj){
  const doc=model.openapi;
  const id=doc?.info?.['x-fal-metadata']?.endpointId;
  const operation=(doc?.paths?.['/'+model.endpoint_id+'/requests/{request_id}']??doc?.paths?.['/'+id+'/requests/{request_id}'])?.get;
  const raw=operation?.responses?.['200']?.content?.['application/json']?.schema;
  return raw?resolveSchema(raw,doc):null;
}
function compatibleOutput(model:Obj){
  const schema=resultSchema(model);
  const file=schema?.properties?.video;
  return schema?.required?.includes('video') && [file,...(file?.allOf||[])].some(v=>v?.properties?.url?.type==='string'&&v.required?.includes('url'));
}
function variants(field:Obj|undefined):Obj[]{
  if(!field)return [];
  return [field,...(field.anyOf||field.oneOf||[]).flatMap((part:Obj)=>variants(part))];
}
function seconds(v:unknown){
  return /^(?:[1-9][0-9]*)(?:s)?$/.test(String(v))?Number(String(v).replace(/s$/,'')):NaN;
}
function allowedDurations(field:Obj|undefined):number[]{
  const allowed=new Set<number>();
  for(const part of variants(field)){
    for(const v of part.enum||[]){const n=seconds(v);if(Number.isInteger(n))allowed.add(n);}
    if(part.type==='integer' && Number.isInteger(part.minimum) && Number.isInteger(part.maximum) && part.minimum>0 && part.maximum<=600){
      for(let i=part.minimum;i<=part.maximum;i++)allowed.add(i);
    }
  }
  return [...allowed].sort((a,b)=>a-b);
}
function audioControl(props:Obj){return ['generate_audio','audio','generate_sound'].find(k=>variants(props[k]).some(v=>v.type==='boolean'));}
function imageControl(props:Obj){return ['image_url','start_image_url','first_frame_url','start_frame_url'].find(k=>k in props);}
function pricingParagraph(text:string){
  return text.match(/^## Pricing\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.split(/\nFor more details, see /)[0].replace(/\*\*/g,'').trim()||'';
}
function h3MaxOutputPadding(schema:Obj) {
  const duration=schema.properties?.duration;
  const expansion=schema.properties?.prompt_expansion_mode;
  const match=String(duration?.description||'').match(/output can run up to (?:about )?([\d.]+) s longer than requested/i);
  const padding=Number(match?.[1]);
  const disablesExpansion=expansion?.type==='string' &&
    (expansion.enum||expansion.examples||[]).includes('disabled');
  if(duration?.type!=='number'||duration.minimum<=0||duration.maximum>30||
    !Number.isFinite(duration.minimum)||!Number.isFinite(duration.maximum)||!disablesExpansion||
    !Number.isFinite(padding)||padding<=0||padding>2) return undefined;
  return padding;
}
function h3MaxTariff(paragraph:string):Billing|null {
  const promotions = /^Billing is calculated per second of video generated\. Through [A-Z][a-z]+ \d+, \d{4}, the \d+% promotional discount applies: \$[\d.]+ at 480p, \$[\d.]+ at 768p, and \$[\d.]+ at 1080p per second\. From [A-Z][a-z]+ \d+ through [A-Z][a-z]+ \d+, \d{4}, get \d+% off standard rates: \$[\d.]+ at 480p, \$[\d.]+ at 768p, and \$[\d.]+ at 1080p per second\. During the [A-Z][a-z]+ promotion, \d+ seconds of video at 768p costs \$[\d.]+\. /;
  const current = paragraph.replace(promotions,'');
  const tariff=current.match(/^From ([A-Z][a-z]+ \d+, \d{4}), standard rates are \$(\d+(?:\.\d+)?), \$(\d+(?:\.\d+)?), and \$(\d+(?:\.\d+)?) per second at 480p, 768p, and 1080p, respectively\. Contact your sales representative to discuss permanent discounted pricing\.$/);
  if(current===paragraph||!tariff) return null;
  const effective=Date.parse(tariff[1]+' 00:00:00 UTC');
  const rates={'480p':Number(tariff[2]),'768p':Number(tariff[3]),'1080p':Number(tariff[4])};
  return Number.isFinite(effective)&&Date.now()>=effective&&Object.values(rates).every(v=>v>0)?{rates}:null;
}
function billingRules(endpoint:string,paragraph:string):Billing|null{
  if(!paragraph || /tokens?|roughly|approximately|compute|minimum charge/i.test(paragraph))return null;
  // Parse only complete, documented tariffs for the verified version. Reject new clauses and unknown units.
  const cost='\\$(\\d+(?:\\.\\d+)?)';
  const rates:Record<string,number>={};
  const p=paragraph.replace(/\s+/g,' ').trim();
  if(endpoint===H3_MAX_IMAGE)return h3MaxTariff(p);
  let reference_image_usd:number|undefined;
  const collect=(pattern:RegExp,priceIndex:number,tierIndex:number)=>{
    for(const match of p.matchAll(pattern))rates[match[tierIndex].toLowerCase()]=Number(match[priceIndex]);
  };
  if(endpoint==='xai/grok-imagine-video/edit-video'){
    const match=p.match(/^Cost is \$(\d+(?:\.\d+)?) per second of 480p output video \(\$(\d+(?:\.\d+)?) at 720p\) plus \$(\d+(?:\.\d+)?) per second of input video\. For example, a 6-second 480p video from a 6-second input costs \$[\d.]+\.$/);
    if(!match)return null;
    return {rates:{'480p':Number(match[1]),'720p':Number(match[2])},source_second_usd:Number(match[3])};
  }else if(/^xai\/grok-imagine-video\/v1\.5\/(?:text|image)-to-video$/.test(endpoint)){
    if(!/^Priced per second of output video, by resolution: (?:\d+p at \$[\d.]+\/sec(?:, |\. ))+A 5-second (?:[\d,psa-z $.;]+)\. Cost scales linearly with duration\. (?:No input images or references, so no per-image charges apply\.|Each reference image adds \$[\d.]+ \(1–7 supported\)\. A reference audio clip, if provided, is included at no extra cost\.)$/.test(p))return null;
    collect(new RegExp('(\\d+p) at '+cost+'/sec','g'),2,1);
    const extra=p.match(/Each reference image adds \$(\d+\.\d+)/);if(extra)reference_image_usd=Number(extra[1]);
  }else if(/^google\/gemini-omni-flash\/v1\.1\//.test(endpoint)){
    if(!/^Billing is calculated per second of output video, by resolution\. For (?:\d+p|4K), your request will cost \$[\d.]+ per second(?:; (?:and )?for (?:\d+p|4K), \$[\d.]+ per second)+\. A 10-second 1080p clip costs \$[\d.]+, while the same clip at 360p costs \$[\d.]+\.$/.test(p))return null;
    collect(new RegExp('(\\d+p|4K), (?:your request will cost )?'+cost+' per second','gi'),2,1);
  }else if(/^alibaba\/wan-3\.0\/(?:text|image)-to-video$/.test(endpoint)){
    if(!/^For every second of video you generate, you will be charged (?:\$[\d.]+ \d+p(?:, |, or |\. ))+For example, a 5s video at 720p will cost \$[\d.]+\. Pricing is subject to change\.$/.test(p))return null;
    collect(new RegExp(cost+' (\\d+p)','g'),1,2);
  }else if(/^blackforestlabs\/flux-3\/(?:text|image)-to-video$/.test(endpoint)){
    if(!/^Your request will be charged at (?:\$[\d.]+ per second(?: of generated video)? at (?:\d+p|[24]K \(\d+p\))(?:, |, and |\.))+$/.test(p))return null;
    collect(new RegExp(cost+' per second(?: of generated video)? at (?:[24]K \\()?([0-9]+p)','g'),1,2);
  }else if(/^minimax\/h3\/(?:text|image)-to-video$/.test(endpoint)){
    if(!/^Video costs (?:\$[\d.]+ per second at (?:\d+p|[24]K)(?:, | and |\.))+$/.test(p))return null;
    collect(new RegExp(cost+' per second at (\\d+p|[24]K)','g'),1,2);
  }else{
    // Simple flat per-output-second documentation can support previously unseen models, without treating examples as rates.
    const flat=p.match(/^Your request will (?:cost|be charged at) \$(\d+(?:\.\d+)?) per second of (?:generated|output) video\.$/i);
    if(flat)rates['*']=Number(flat[1]);
    const perRequest=p.match(/^Your request will (?:cost|be charged at) \$(\d+(?:\.\d+)?) per (?:generated video|request)\.$/i);
    if(perRequest && Number(perRequest[1])>0)return {rates:{'*':Number(perRequest[1])},basis:'per_request'};
  }
  return Object.keys(rates).length && Object.values(rates).every(v=>Number.isFinite(v)&&v>0)?{rates,reference_image_usd}:null;
}
async function livePriceRows(ids:string[],request:typeof fetch):Promise<Map<string,Obj>>{
  const url=new URL(API+'/pricing');
  ids.forEach(id=>url.searchParams.append('endpoint_id',id));
  const result=await readJson(url,request,'pricing',{headers:auth()});
  if(!Array.isArray(result?.prices)||result.has_more===true)throw new FalRegistryError('pricing','invalid');
  return new Map(result.prices.filter((p:Obj)=>typeof p?.endpoint_id==='string'&&ids.includes(p.endpoint_id)).map((p:Obj)=>[p.endpoint_id,p]));
}
function absentPrice(e:unknown){
  // Some exact catalog entries lack an account price. Authentication, throughput, schema and server errors are outages.
  return e instanceof FalRegistryError && e.stage==='pricing' && e.status===404;
}
async function singlePrice(id:string,request:typeof fetch){
  try {return (await livePriceRows([id],request)).get(id)??null;}
  catch(e){if(absentPrice(e))return null;throw e;}
}
// Fresh lookup batches are scoped to ONE Arena synchronization. Quote and pre-dispatch calls always fetch independently.
export function createRankedFalDiscovery(rows:readonly {name:string;category:VideoCategory}[],request:typeof fetch=fetch){
  const ids=new Set<string>();
  for(const row of rows){
    const name=row.name.replace(/\s*\(\d+p\)$/i,'');
    const id=knownAlias(canonicalName(name),row.category);
    if(id)ids.add(id);
  }
  const scheduled=[...ids];
  let batch:Promise<Map<string,Obj>>|undefined;
  const singles=new Map<string,Promise<Obj|null>>();
  const one=(endpoint:string)=>{
    let p=singles.get(endpoint);
    if(!p){p=singlePrice(endpoint,request);singles.set(endpoint,p);}
    return p;
  };
  async function lookup(endpoint:string){
    if(!ids.has(endpoint)||scheduled.length>50)return one(endpoint);
    batch??=livePriceRows(scheduled,request);
    try{return (await batch).get(endpoint)??null;}
    catch(e){
      // Invalid/absent IDs in a batch must not hide a valid sibling. Never fan out on auth failures or throttling.
      if(e instanceof FalRegistryError && [400,404,422].includes(e.status??0))return one(endpoint);
      throw e;
    }
  }
  const chunks=new Map<string,string[]>();
  for(let i=0;i<scheduled.length;i+=10){
    const chunk=scheduled.slice(i,i+10);
    for(const id of chunk)chunks.set(id,chunk);
  }
  const batches=new Map<string,Promise<Map<string,Obj>>>();
  const searches=new Map<string,Promise<Obj>>();
  const scope:CatalogScope={
    async exact(endpoint){
      const ids=chunks.get(endpoint)??[endpoint],key=ids.join(',');
      let rows=batches.get(key);
      if(!rows){rows=catalogGroup(ids,request);batches.set(key,rows);}
      return (await rows).get(endpoint)??null;
    },
    search(label){
      const key=canonicalName(label);
      let rows=searches.get(key);
      if(!rows){rows=searchCatalog(label,request);searches.set(key,rows);}
      return rows;
    }
  };
  return (name:string,category:VideoCategory)=>discoverRankedModel(name,category,request,lookup,scope);
}
async function details(endpoint:string,request:typeof fetch,lookup?:PriceLookup){
  // Fetch independent evidence, so a pricing outage cannot erase a verified model and its schema.
  const [docResult,priceResult]=await Promise.allSettled([
    read('https://fal.ai/models/'+endpoint+'/llms.txt',request,'documentation',{},true)
      .then(async r=>{try{return await r.text();}catch{throw new FalRegistryError('documentation','invalid');}})
      .catch(e=>{if(e instanceof MissingEndpoint)return null;throw e;}),
    process.env.FAL_KEY?(lookup?lookup(endpoint):singlePrice(endpoint,request)):Promise.reject(new FalRegistryError('pricing','credentials')),
  ]);
  const issues:string[]=[];
  let docs:string|null=null;
  if(docResult.status==='rejected')issues.push(registryIssue(docResult.reason));
  else if(docResult.value!==null && !docResult.value.includes('`'+endpoint+'`'))issues.push(registryIssue(new FalRegistryError('documentation','identity')));
  else docs=docResult.value;
  if(priceResult.status==='rejected')issues.push(registryIssue(priceResult.reason));
  const paragraph=docs?pricingParagraph(docs):'';
  const row=priceResult.status==='fulfilled'?priceResult.value:null;
  const price=row?.currency==='USD'&&Number.isFinite(row.unit_price)&&row.unit_price>0&&typeof row.unit==='string'
    ?{currency:'USD',unit_price:Number(row.unit_price),unit:String(row.unit)}:null;
  return {price,billing:billingRules(endpoint,paragraph),pricing_description:paragraph.slice(0,1700),
    ...(issues.length?{verification_error:issues.join(' / ')}:{})};
}
export const UGC_IMAGE_MODELS = ['fal-ai/nano-banana-pro/edit', 'fal-ai/nano-banana-2/edit'] as const;
export const UGC_IMAGE_REFERENCES = ['https://studio.cloudbath.co/internal/ugc-product.png','https://studio.cloudbath.co/internal/ugc-presenter.png'] as const;

export async function estimateUgcImage(endpoint:string, prompt:string, portrait:boolean, request:typeof fetch=fetch) {
  if (!(UGC_IMAGE_MODELS as readonly string[]).includes(endpoint)) throw Error('โมเดลนี้ยังไม่รองรับภาพอ้างอิง UGC');
  const [found, info]=await Promise.all([catalogGroup([endpoint],request).then(rows=>rows.get(endpoint)),details(endpoint,request)]);
  const paragraph=info.pricing_description.replace(/\s+/g,' ').trim();
  // One 1K image, no optional search, higher resolution or explicit high thinking.
  const normal=/^Your request will cost \$(\d+(?:\.\d+)?) per image\. For \$[\d.]+, you can (?:generate \d+ standard images|run this model \d+ times)\. /.exec(paragraph);
  const extras=normal && paragraph.slice(normal[0].length);
  const supported=endpoint.endsWith('/nano-banana-pro/edit') ?
    /^4K outputs will be charged at double the standard rate\. If web search is used, an additional \$[\d.]+ will be charged\. Note: Pricing may change in the future\.$/ :
    /^2K and 4K outputs will be charged at [\d.]+ times and [\d.]+ times the standard rate, respectively\. 0\.5K \(512px\) resolution outputs will be charged at [\d.]+ times the standard rate\. If web search is used, an additional \$[\d.]+ will be charged\. If high thinking is used, an additional \$[\d.]+ will be charged\. Note: Pricing is subject to change\.$/;
  if (!found || found.metadata?.status!=='active' || !info.price || !/^images?$/i.test(info.price.unit) ||
      !normal || !(Number(normal[1])>0) || !extras || !supported.test(extras))
    throw Error(info.verification_error || 'ยังยืนยันเรต 1K ต่อภาพจาก fal.ai ไม่ได้');
  const schema=inputSchema(found);
  const result=resultSchema(found);
  const images=result?.properties?.images;
  if(!result?.required?.includes('images')||images?.type!=='array'||images.items?.properties?.url?.type!=='string')
    throw Error('ตัวอ่านผลลัพธ์ยังไม่รองรับภาพของโมเดลนี้');
  const payload={prompt,image_urls:UGC_IMAGE_REFERENCES.slice(0,portrait?2:1),num_images:1,output_format:'jpeg',
    resolution:'1K',aspect_ratio:'9:16',enable_web_search:false};
  const valid=schemaValidators.compile(schema);
  if(!Object.keys(payload).every(key=>key in schema.properties)||!valid(payload))
    throw Error('รูปแบบเฟรมคนถือสินค้าไม่ตรงกับ schema ของ fal.ai');
  const estimate=await readJson(API+'/pricing/estimate',request,'estimate',{method:'POST',headers:auth('estimate'),
    body:JSON.stringify({estimate_type:'unit_price',endpoints:{[endpoint]:{unit_quantity:1}}})});
  if(estimate.estimate_type!=='unit_price'||estimate.currency!=='USD'||!Number.isFinite(estimate.total_cost)||
      Math.abs(estimate.total_cost-info.price.unit_price)>1e-6) throw Error('ราคาเฟรมเปิดจาก fal.ai ไม่ตรงกับราคาบัญชี');
  return {endpoint_id:endpoint,model_name:String(found.metadata.display_name||endpoint),payload,
    schema_hash:createHash('sha256').update(stableJson(schema)).digest('hex'),resolution:'1K',
    billing_quantity:1,billing_unit:info.price.unit,unit_usd:Math.max(info.price.unit_price,Number(normal[1])),
    estimated_usd:Math.max(info.price.unit_price,Number(normal[1])),account_unit_usd:info.price.unit_price,
    pricing_source:'https://fal.ai/models/'+endpoint,pricing_checked_at:new Date().toISOString()};
}

export async function getVideoModel(endpoint:string,category:VideoCategory,request:typeof fetch=fetch,lookup?:PriceLookup,scope?:CatalogScope):Promise<FalVideoModel>{
  validateEndpointId(endpoint);
  const found=scope?await scope.exact(endpoint):(await catalogGroup([endpoint],request)).get(endpoint);
  if(!found || classified(endpoint,found.metadata||{})!==category)throw new MissingEndpoint('No verified fal endpoint for this category');
  const active=found.metadata.status==='active';
  // A catalog entry can lack a usable queue schema. Retain its ranking and observed price.
  // Transport failures still propagate so refresh preserves the prior successful snapshot.
  let schema:Obj={},compatible=false,knownSchema=true;
  try{schema=inputSchema(found);compatible=!!compatibleOutput(found);}
  catch{knownSchema=false;}
  const props=schema.properties||{};
  let durations=allowedDurations(props.duration||props.duration_seconds);
  const padding=endpoint===H3_MAX_IMAGE?h3MaxOutputPadding(schema):undefined;
  if(padding) {
    const min=Math.ceil(props.duration.minimum),max=Math.floor(props.duration.maximum);
    durations=Array.from({length:Math.max(0,max-min+1)},(_,i)=>i+min);
  }
  const trimBound=sourceTrimLimit(endpoint,schema);
  if(trimBound)durations=Array.from({length:trimBound},(_,i)=>i+1);
  const resolutions:string[]=[...new Set<string>(variants(props.resolution).flatMap(f=>f.enum||[]).filter((v:unknown)=>typeof v==='string' && /^(?:\d+p|[248]k)$/i.test(v)))];
  const info=await details(endpoint,request,lookup);
  const audio=audioControl(props)?true:(/\b(?:native audio|with audio|synchronized audio)\b/i.test(found.metadata.description||'')?true:null);
  const billableUnit=info.billing?.basis==='per_request'?/^(?:requests?|videos?|generations?)$/i:/^seconds?$/i;
  const available=!!(active&&compatible&&info.price&&billableUnit.test(info.price.unit)&&info.billing&&durations.length&&resolutions.length&&
    resolutions.some(r=>info.billing!.rates[r.toLowerCase()]||info.billing!.rates['*'])&&
    props.prompt&&(endpoint!==H3_MAX_IMAGE||padding)&&(category!=='image-to-video'||imageControl(props))&&
    (category!=='video-to-video'&&category!=='video-editing'||videoControl(props)));
  return {endpoint_id:endpoint,name:found.metadata.display_name,category,endpoint_available:active,available,resolutions,durations,audio,
    input_schema:schema,schema_hash:createHash('sha256').update(stableJson(schema)).digest('hex'),source_url:'https://fal.ai/models/'+endpoint+'/api',
    checked_at:new Date().toISOString(),...info,...(padding?{output_padding_seconds:padding}:{}),...(available?{}:{reason:info.verification_error||(!active?'fal ระบุว่า endpoint นี้ยังไม่เปิดใช้งาน':!knownSchema?'ยังตรวจรูปแบบคำขอของรุ่นนี้ไม่ได้':!compatible?'ตัวอ่านวิดีโอยังไม่รองรับรูปแบบผลลัพธ์ของรุ่นนี้':!info.price?'ยังตรวจราคาบัญชีเป็น USD ไม่ได้':
      !info.billing?'ยังคำนวณราคาครบตามการตั้งค่าของรุ่นนี้ไม่ได้':!durations.length?'เวลาผลิตขึ้นกับคลิปต้นทาง หรือยังไม่มีช่วงเวลาที่ตรวจสอบได้':
      'การตั้งค่าหรือหน่วยคิดเงินของรุ่นนี้ยังไม่รองรับ')})};
}
function stableJson(value:any):string{
  if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJson(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function videoControl(props:Obj){
  return ['video_url','reference_video_urls'].find(k=>k in props);
}
// This is the explicit provider limit. The worker re-encodes a hash-verified source to exactly the purchased seconds.
function sourceTrimLimit(endpoint:string,schema:Obj){
  if(endpoint!=='xai/grok-imagine-video/edit-video')return 0;
  const match=String(schema.properties?.video_url?.description||'').match(/truncated to (\d+) seconds/i);
  const n=Number(match?.[1]);
  return Number.isSafeInteger(n)&&n>0&&n<=60?n:0;
}
function falHostedVideo(value:unknown){
  if(!httpsInput(value))return false;
  const u=new URL(value as string);return !u.port && (u.hostname==='fal.media' || u.hostname.endsWith('.fal.media'));
}
function httpsInput(v:unknown){
  if(typeof v!=='string')return false;
  try{const u=new URL(v);return u.protocol==='https:'&&!!u.hostname&&!u.username&&!u.password;}catch{return false;}
}
export function validateVideoPayload(model:FalVideoModel,payload:Record<string,unknown>):void{
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid fal payload');
  for(const [key,value] of Object.entries(payload)){
    if(!Object.hasOwn(model.input_schema.properties||{},key) || value===undefined)throw new Error('Unknown fal payload field '+key);
    if(key.endsWith('_urls')&&(!Array.isArray(value)||!value.every(httpsInput)))throw new Error('Invalid HTTPS media list for '+key);
    if(key.endsWith('_url')&&!httpsInput(value))throw new Error('Invalid HTTPS media URL for '+key);
  }
  if(model.category==='image-to-video'&&!payload[imageControl(model.input_schema.properties)||''])throw new Error('Image-to-video requires a first frame');
  if(model.category==='video-editing'||model.category==='video-to-video'){
    const ref=videoControl(model.input_schema.properties);
    if(!ref || !payload[ref] || Array.isArray(payload[ref])&&(payload[ref] as unknown[]).length!==1)throw new Error('One video input required');
    if(sourceTrimLimit(model.endpoint_id,model.input_schema)&&!falHostedVideo(payload[ref]))throw new Error('This video edit requires a fal.media source for duration verification');
  }
  const valid=schemaValidators.compile(model.input_schema);
  if(!valid(payload))throw new Error('Invalid fal payload: '+schemaValidators.errorsText(valid.errors));
}
type SceneInput={prompt:string;duration:number;resolution:string;audio:boolean;image_url?:string;video_url?:string;aspect_ratio?:string};
export function buildVideoPayload(model:FalVideoModel,scene:SceneInput):Record<string,unknown>{
  if(!model.available)throw new Error(model.reason||'fal model is unavailable');
  if(!scene.prompt?.trim() || !model.durations.includes(scene.duration))throw new Error('Unsupported prompt or duration for '+model.endpoint_id);
  const res=model.resolutions.find(r=>r.toLowerCase()===scene.resolution.toLowerCase());
  if(!res)throw new Error('Unsupported fal resolution');
  const props=model.input_schema.properties;
  const dk=props.duration?'duration':'duration_seconds';
  const options=variants(props[dk]).flatMap(f=>f.enum||[]);
  const duration=options.find(v=>seconds(v)===scene.duration)??scene.duration;
  const payload:Record<string,unknown>={prompt:scene.prompt,resolution:res};
  if(model.endpoint_id===H3_MAX_IMAGE)payload.prompt_expansion_mode='disabled';
  if(props[dk])payload[dk]=duration;
  else if(!sourceTrimLimit(model.endpoint_id,model.input_schema))throw new Error('Missing verified duration control');
  const audio=audioControl(props);
  if(audio)payload[audio]=scene.audio;
  else if(scene.audio && model.audio!==true)throw new Error('Native audio is unverified for this endpoint');
  if(scene.aspect_ratio){
    if(props.aspect_ratio)payload.aspect_ratio=scene.aspect_ratio;
    else if(model.category==='text-to-video')throw new Error('Requested aspect ratio is unsupported');
  }
  if(scene.image_url){
    const key=imageControl(props);if(!key || model.category!=='image-to-video')throw new Error('First frame not supported on this route');
    payload[key]=scene.image_url;
  }
  if(scene.video_url){
    const field=videoControl(props);
    if(!field || !['video-editing','video-to-video'].includes(model.category))throw new Error('Video input unsupported on this route');
    payload[field]=field==='reference_video_urls'?[scene.video_url]:scene.video_url;
  }
  validateVideoPayload(model,payload);return payload;
}
export function previewVideoPayload(model:FalVideoModel,payload:Record<string,unknown>,quantity=1,verifiedMediaSeconds?:number){
  validateVideoPayload(model,payload);
  if(!model.available||!model.billing||!model.price||!Number.isSafeInteger(quantity)||quantity<1)throw new Error('No verified fal quote available');
  const trimmed=sourceTrimLimit(model.endpoint_id,model.input_schema);
  const duration=seconds(trimmed?verifiedMediaSeconds:payload.duration??payload.duration_seconds);
  const rate=model.billing.rates[String(payload.resolution).toLowerCase()]??model.billing.rates['*'];
  const allowed=new Set(['prompt','duration','duration_seconds','resolution','aspect_ratio',videoControl(model.input_schema.properties),imageControl(model.input_schema.properties),audioControl(model.input_schema.properties)]);
  if(model.endpoint_id===H3_MAX_IMAGE){
    if(!model.output_padding_seconds||payload.prompt_expansion_mode!=='disabled')throw Error('Unpriced H3 Max configuration');
    allowed.add('prompt_expansion_mode');
  }
  if(!rate||!model.durations.includes(duration)||!model.resolutions.some(r=>r===payload.resolution)||Object.keys(payload).some(k=>!allowed.has(k)))throw new Error('Unpriced fal configuration');
  const perRequest=model.billing.basis==='per_request';
  const billableSeconds=model.output_padding_seconds?Math.ceil(duration+model.output_padding_seconds):duration;
  const units=perRequest?quantity:quantity*billableSeconds;
  const inputCount=model.category==='image-to-video'?1:0;
  const documented=quantity*(rate*(perRequest?1:billableSeconds)+inputCount*(model.billing.reference_image_usd||0)+
    (trimmed?duration*(model.billing.source_second_usd||0):0));
  return {usd:Math.ceil(Math.max(documented,model.price.unit_price*units)*1e6-1e-8)/1e6,unit:model.price.unit,quantity:units};
}
export async function estimateVideoPayload(model:FalVideoModel,payload:Record<string,unknown>,quantity=1,request:typeof fetch=fetch,verifiedMediaSeconds?:number):Promise<{usd:number;unit:string;quantity:number}>{
  const preview=previewVideoPayload(model,payload,quantity,verifiedMediaSeconds);
  const body={estimate_type:'unit_price',endpoints:{[model.endpoint_id]:{unit_quantity:preview.quantity}}};
  const estimate=await readJson(API+'/pricing/estimate',request,'estimate',{method:'POST',headers:auth('estimate'),body:JSON.stringify(body)});
  if(estimate.estimate_type!=='unit_price'||estimate.currency!=='USD'||!Number.isFinite(estimate.total_cost)||estimate.total_cost<0||
    Math.abs(estimate.total_cost-model.price!.unit_price*preview.quantity)>0.010001)throw new Error('fal quote changed or estimate is inconsistent');
  return {...preview,usd:Math.ceil(Math.max(preview.usd,estimate.total_cost)*1e6-1e-8)/1e6};
}
