import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {sourceKey} from './source-evidence.js';

// Registry contains identifiers/metadata only, never upstream style documents.
const BUILTIN_STYLES = [
  {id:'dataviz',name:'Data Storytelling',capabilities:['charts','labels','comparisons'],limits:['verified numeric data only','Canvas2D']},
  {id:'firefly-pointillism',name:'Firefly Pointillism',capabilities:['particles','atmosphere','metaphors'],limits:['avoid dense small labels','Canvas2D']},
  {id:'rubber-hose',name:'Rubber Hose',capabilities:['characters','expressions','comedy'],limits:['original characters only','Canvas2D']},
] as const;
type LemoStyle = {id:string; name:string; category:string; uses:string[]; mode:'canvas2d'|'adapted'};
const CATALOG: LemoStyle[] = JSON.parse(readFileSync(new URL('./lemo-styles.json',import.meta.url),'utf8'));
const BASE_CATALOG = BUILTIN_STYLES.map(style=>({...CATALOG.find(item=>item.id===style.id)!,...style}));

export function lemoStyles(env:NodeJS.ProcessEnv=process.env) {
  const library=env.LEMO_STYLE_LIBRARY;
  const full=env.LEMO_FULL_STYLE_CATALOG==='true' && (library==='owner-films'
    ? env.LEMO_FILM_USE_APPROVED==='true' && env.LEMO_PRIVATE_OWNER_MODE==='true'
    : library==='upstream-licensed' && env.LEMO_LICENSE_APPROVED==='true');
  return full ? CATALOG : BASE_CATALOG;
}

const stylesFor = (engine:'classic'|'lemo') => engine==='lemo' ? lemoStyles() : BASE_CATALOG;

export function publicStyles(){
  const previews=JSON.parse(readFileSync(new URL('./lemo-style-previews.json',import.meta.url),'utf8'));
  return lemoStyles().map(style=>({...style,preview:previews[style.id]}));
}
export const LEMO_TYPOGRAPHY_VERSION='all-text-kanit-v2';
export const METRICS=['relevance','storytelling','emotion','characters','continuity','feasibility'] as const;
export const WEIGHTS={relevance:.30,storytelling:.25,emotion:.15,characters:.10,continuity:.10,feasibility:.10};
const S=z.string().trim().min(3).max(1200);
export const CreativeSettings=z.object({
  version:z.literal(1).default(1),engine:z.enum(['classic','lemo']).default('classic'),
  mode:z.enum(['auto','manual']).default('auto'),manual_style:z.string().optional(),locked:z.boolean().default(false),
  tts_model:z.enum(['eleven_v4','eleven_v3','eleven_multilingual_v2']).default('eleven_v4'),
  sfx_model:z.enum(['eleven_text_to_sound_v3','eleven_text_to_sound_v2']).default('eleven_text_to_sound_v3'),
  voice_id:z.string().min(5).max(100).optional(),brand:z.string().max(600).default('Cloudbath'),
  audience:z.string().max(300).default('Thai general audience'),max_usd:z.number().positive().max(1000).default(10),
  weights:z.object(Object.fromEntries(METRICS.map(k=>[k,z.number().min(0).max(1)])) as Record<typeof METRICS[number],z.ZodNumber>).default(WEIGHTS),
}).strict().superRefine((s,c)=>{
  if(s.mode==='manual'&&!stylesFor(s.engine).some(x=>x.id===s.manual_style))c.addIssue({code:'custom',message:'Select an installed style'});
  if(Math.abs(Object.values(s.weights).reduce((a,b)=>a+b,0)-1)>.00001)c.addIssue({code:'custom',message:'Weights must sum to 1'});
});
export type CreativeSettingsT=z.infer<typeof CreativeSettings>;
const Scores=z.object(Object.fromEntries(METRICS.map(k=>[k,z.number().min(0).max(1)])) as Record<typeof METRICS[number],z.ZodNumber>).strict();
export const CreativePlan=z.object({
  analysis:z.object({genre:S,arc:S,tone:S,audience:S,hook:S,factual_density:S,complexity:S,characters:S,locations:S,metaphors:S,pacing:S,identity:S,brand:S,budget:S,capabilities:S}).strict(),
  candidates:z.array(z.object({id:z.string(),scores:Scores,confidence:z.number().min(0).max(1),reasons:z.array(S).min(1).max(6),suitable:z.boolean()}).strict()).min(1).max(3),
  identity:z.object({direction:S,palette:z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(8),typography:S,camera:S,motion:S,characters:S,locations:S,props:S,lighting:S,transitions:S}).strict(),
  scenes:z.array(z.object({seg:z.string().regex(/^[a-z0-9_]{1,24}$/),objective:S,shot:S,camera:S,composition:S,elements:z.array(S).min(1).max(12),emotion:S,location:S,characters:z.array(z.string().max(100)).max(8),transition:S,
    events:z.array(z.object({at:z.number().min(0).max(1),action:S}).strict()).min(2).max(12),
    sound:z.object({decision:z.enum(['effects','ambience','silence']),reason:S,cues:z.array(z.object({id:z.string().regex(/^[a-z0-9_]{1,40}$/),word:z.string().min(1).max(100),occurrence:z.number().int().min(0).max(20).default(0),offset:z.number().min(-.5).max(2).default(0),action:S,prompt:S,duration:z.number().min(.5).max(30),gain:z.number().min(0).max(.6).default(.25)}).strict()).max(5)}).strict(),
  }).strict()).min(1).max(14),
}).strict();
export type CreativePlanT=z.infer<typeof CreativePlan>;
// Share the validator's complete field contract with the planner. An opaque
// object encouraged empty SFX prompts and unsupported renderer fields.
export const CreativePlanToolSchema=zodToJsonSchema(CreativePlan,{$refStrategy:'none'});
export function creativeSourceEvidence(sources:any[],seen:any[]){
  const evidence=new Map(seen.map(x=>[sourceKey(x.url),x]));
  return sources.map(source=>{
    const found=evidence.get(sourceKey(source.url));
    if(!found||!['web','read','search'].includes(found.via))throw Error('Sources must have retrieved URL evidence');
    return {...source,collected:found.collected,retrieved_via:found.via==='web'?'openai_web_search':'firecrawl'};
  });
}
export function hash(v:unknown):string {
  const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
  return createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
}
export function chooseStyle(raw:unknown,settings:CreativeSettingsT,script:{id:string,text:string}[]){
  const plan=CreativePlan.parse(raw),known=new Set(stylesFor(settings.engine).map(x=>x.id));
  if(plan.candidates.some(c=>!known.has(c.id))||new Set(plan.candidates.map(c=>c.id)).size!==plan.candidates.length)throw Error('Unknown or duplicate style');
  if(script.length!==plan.scenes.length||script.some((s,i)=>s.id!==plan.scenes[i].seg))throw Error('Creative scenes must match narration order');
  for(const scene of plan.scenes){
    if((scene.sound.decision==='silence')!==!scene.sound.cues.length)throw Error('Sound decisions must explicitly justify silence or provide cues');
    for(const cue of scene.sound.cues){
      const text=script.find(s=>s.id===scene.seg)!.text;
      let from=0,found=-1;
      for(let n=0;n<=cue.occurrence;n++){found=text.indexOf(cue.word,from);if(found<0)break;from=found+1;}
      if(found<0||!cue.word.replace(/[\s.?!…,\"“”'()\[\]:;\-–—]/g,''))throw Error(`Sound anchor missing in ${scene.seg} at occurrence ${cue.occurrence}`);
    }
    if(new Set(scene.sound.cues.map(c=>c.id)).size!==scene.sound.cues.length)throw Error('Duplicate sound cue');
  }
  const ranked=plan.candidates.filter(c=>c.suitable).map(c=>({...c,score:METRICS.reduce((v,k)=>v+c.scores[k]*settings.weights[k],0)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const manual = settings.mode==='manual' ? settings.manual_style : undefined;
  if (manual && !known.has(manual)) throw Error('Unknown manual style');
  const assessed = manual ? ranked.find(candidate=>candidate.id===manual) : ranked[0];
  const selected = assessed ? {...assessed,unassessed:false} : manual ? {
    id:manual, scores:Object.fromEntries(METRICS.map(key=>[key,0])) as Record<typeof METRICS[number],number>,
    score:0, confidence:0, suitable:false, unassessed:true,
    reasons:['คุณเลือกแนวภาพนี้เอง ตรวจองค์ประกอบและการเคลื่อนไหวของแต่ละฉากก่อนผลิต'],
  } : undefined;
  if(!selected)throw Error('No compatible installed style; adjust the plan');
  return {selected,alternatives:ranked.filter(c=>c.id!==selected.id),low_confidence:selected.confidence<.65,plan,cache_key:hash({script,settings,plan}),weights:settings.weights};
}
export function creativePrompt(settings:CreativeSettingsT){return `\nCREATIVE MOTION v1: Include a creative object in plan_story in the SAME planning call. No extra style request. Analyze the actual complete story, not keywords or randomness. Explain all user-facing reasons and scene directions in Thai. In each regular storyboard shot also include subjects [{id,description}] naming the concrete subjects. Schema: analysis {genre,arc,tone,audience,hook,factual_density,complexity,characters,locations,metaphors,pacing,identity,brand,budget,capabilities}, candidates [{id,scores:{relevance,storytelling,emotion,characters,continuity,feasibility},confidence,reasons:[text],suitable}], identity {direction,palette:[hex],typography,camera,motion,characters,locations,props,lighting,transitions}, scenes [{seg,objective,shot,camera,composition,elements:[text],emotion,location,characters:[name],transition,events:[{at:0..1,action}],sound:{decision:effects|ambience|silence,reason,cues:[{id,word:EXACT narration anchor,occurrence:0,offset:0,action,prompt,duration:0.5..30,gain:0..0.6}]}}]. Scores/confidence 0..1. Describe ALL analysis fields substantively. At least two motivated motion events per scene. One stable film identity. Every scene needs a sound decision, deliberate silence has empty cues. Every sound cue prompt must describe the actual audible event in English, never cache instructions or library identifiers; the worker handles reuse automatically. Avoid repetitive whooshes, no automatic music or image generation. No invented statistics, evidence or medical claims. Consider the whole catalog below against the actual story before returning up to three candidates. In manual mode include and plan the visual identity for the owner-selected style. Each row is ID | name | category | typical uses. Available styles:\n${stylesFor(settings.engine).map(style=>[style.id,style.name,style.category,style.uses.join(', ')].join(' | ')).join('\n')}\n Settings: ${JSON.stringify(settings)}. ${settings.engine==='lemo'?'LEMO OVERRIDE: After plan_story, submit_episode with title_th, angle, sources, claims and captions only; do NOT call drawing tools or write Python. The separate isolated coding worker renders after owner approval.':''}`;}
export function releaseGates(env:NodeJS.ProcessEnv=process.env){
  const library=env.LEMO_STYLE_LIBRARY||'cloudbath-original-v1';
  const permission=library==='cloudbath-original-v1'?['LEMO_ORIGINAL_STYLE_VERIFIED']:library==='owner-films'?['LEMO_FILM_USE_APPROVED','LEMO_PRIVATE_OWNER_MODE']:['LEMO_LICENSE_APPROVED'];
  const names=[...permission,'LEMO_SECURITY_VERIFIED','LEMO_RENDER_VERIFIED','LEMO_V4_VERIFIED','LEMO_SFX_V3_VERIFIED','LEMO_THAI_SYNC_VERIFIED','LEMO_COST_VERIFIED','LEMO_CLASSIC_REGRESSION_VERIFIED'];
  const blockers=names.filter(k=>env[k]!=='true');if(!['cloudbath-original-v1','owner-films','upstream-licensed'].includes(library))blockers.push('LEMO_STYLE_LIBRARY');
  return {enabled:env.LEMO_ENABLED==='true'&&!blockers.length,blockers,development:env.LEMO_DEVELOPMENT==='true',style_library:library};
}
export const CATEGORIES=['planning','style','coding','narration','sfx','music','compute','other'] as const;
// Compute bounded allocations on the server for the owner's single confirmation.
// These are request reservations, never a claim that unknown provider rates are zero.
export function productionApproval(row:any,quote:{items:{category:string;quantity:number;estimated_usd:number|null}[];unknown:string[]}){
  const cap=Number(row.creative?.settings?.max_usd);
  const base={max_usd:cap,allocations:{} as Record<string,number>,unknown_ack_required:quote.unknown.length>0,style_ack_required:row.creative?.selection?.low_confidence===true};
  const blocked=(reason:string)=>({...base,available:false as const,reason});
  if(!Number.isFinite(cap)||cap<=0||cap>1000)return blocked('วงเงินของร่างไม่ถูกต้อง กรุณาตรวจการตั้งค่าร่าง');
  if(quote.items.some(item=>!Number.isFinite(item.quantity)||item.quantity<0))return blocked('ยังคำนวณรายการผลิตไม่ได้ กรุณาตรวจข้อมูลร่าง');
  const active=quote.items.filter(item=>item.quantity>0);
  if(!active.length||active.some(item=>!Number.isFinite(item.quantity)||item.estimated_usd!==null&&(!Number.isFinite(item.estimated_usd)||item.estimated_usd<0)))return blocked('ยังคำนวณรายการผลิตไม่ได้ กรุณาตรวจข้อมูลร่าง');
  // Integer microdollars match the ledger precision and keep rounding inside the saved cap.
  const total=Math.floor(cap*1e6+1e-7);
  const reservations=active.map(item=>Math.max(1,Math.ceil((item.estimated_usd??0)*1e6-1e-7)));
  const required=reservations.reduce((sum,value)=>sum+value,0);
  if(!Number.isSafeInteger(required)||required>total)return blocked('รายการผลิตเกินวงเงินที่ตั้งไว้ กรุณาลดขนาดงานหรือปรับวงเงินในร่างก่อนยืนยัน');
  const spare=total-required,each=Math.floor(spare/active.length),remainder=spare%active.length;
  const allocations=Object.fromEntries(active.map((item,index)=>[item.category,(reservations[index]+each+(index<remainder?1:0))/1e6]));
  return {...base,available:true as const,allocations};
}
export function estimateCreative(row:any,pkg:any,rates:Record<string,any>={}){
  const chars=pkg.script.reduce((n:number,s:any)=>n+Array.from(s.text).length,0),sec=pkg.sfx.reduce((n:number,s:any)=>n+s.duration,0);
  const quantities:Record<string,number>={planning:0,style:0,coding:row.creative.engine==='lemo'?pkg.script.length*2:0,narration:chars,sfx:sec,music:pkg.music?.source==='generate'?1:0,compute:1,other:0};
  const models:Record<string,string|undefined>={coding:row.model,narration:pkg.voice?.model_id,sfx:pkg.sfx[0]?.model_id,music:pkg.music?.model_id,compute:row.creative.engine==='lemo'?'canvas2d':'classic'};
  const items=CATEGORIES.map(category=>{const rate=rates[category],quantity=quantities[category];const valid=rate&&rate.model===models[category]&&(!rate.valid_until||Date.parse(rate.valid_until)>Date.now())&&typeof rate.usd_per_unit==='number'&&Number.isFinite(rate.usd_per_unit)&&rate.usd_per_unit>=0&&typeof rate.source==='string'&&rate.source.trim()&&typeof rate.checked_at==='string'&&!Number.isNaN(Date.parse(rate.checked_at));return {category,quantity,unit:{planning:'already incurred',style:'included in planning',coding:'bounded code attempts',narration:'characters',sfx:'seconds',music:'track',compute:'job',other:'none'}[category],estimated_usd:quantity===0?0:valid?quantity*rate.usd_per_unit:null,rate:valid?rate:null,note:category==='planning'?'Planning already incurred; actual provider token usage shown separately':category==='style'?'Included in story planning; explicit regeneration needs a new approval':''};});
  const quote={revision:hash({draft:row.draft,storyboard:row.storyboard,creative:row.creative,source_text:row.source_text}),items,known_total_usd:items.reduce((n,i)=>n+(i.estimated_usd||0),0),unknown:items.filter(i=>i.estimated_usd===null).map(i=>i.category),planning_usage:row.usage||{},currency:'USD'};
  const approval=productionApproval(row,quote);
  return {...quote,...(row.creative.engine==='lemo'?{lemo_approval:approval}:{classic_approval:approval})};
}
