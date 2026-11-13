import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';

// Registry contains identifiers/metadata only, never upstream style documents.
export const LEMO_STYLES = [
  {id:'dataviz',name:'Data Storytelling',capabilities:['charts','labels','comparisons'],limits:['verified numeric data only','Canvas2D']},
  {id:'firefly-pointillism',name:'Firefly Pointillism',capabilities:['particles','atmosphere','metaphors'],limits:['avoid dense small labels','Canvas2D']},
  {id:'rubber-hose',name:'Rubber Hose',capabilities:['characters','expressions','comedy'],limits:['original characters only','Canvas2D']},
] as const;
export function publicStyles(){const previews=JSON.parse(readFileSync(new URL('./lemo-style-previews.json',import.meta.url),'utf8'));return LEMO_STYLES.map(x=>({...x,preview:previews[x.id],preview_label:'ภาพตัวอย่างจาก fixture ไม่ใช่เฟรมของเรื่องนี้'}));}
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
  if(s.mode==='manual'&&!LEMO_STYLES.some(x=>x.id===s.manual_style))c.addIssue({code:'custom',message:'Select an installed style'});
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
export function hash(v:unknown):string {
  const canonical=(x:any):any=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
  return createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
}
export function chooseStyle(raw:unknown,settings:CreativeSettingsT,script:{id:string,text:string}[]){
  const plan=CreativePlan.parse(raw),known=new Set<string>(LEMO_STYLES.map(x=>x.id));
  if(plan.candidates.some(c=>!known.has(c.id))||new Set(plan.candidates.map(c=>c.id)).size!==plan.candidates.length)throw Error('Unknown or duplicate style');
  if(script.length!==plan.scenes.length||script.some((s,i)=>s.id!==plan.scenes[i].seg))throw Error('Creative scenes must match narration order');
  for(const scene of plan.scenes){
    if((scene.sound.decision==='silence')!==!scene.sound.cues.length)throw Error('Sound decisions must explicitly justify silence or provide cues');
    for(const cue of scene.sound.cues)if(!script.find(s=>s.id===scene.seg)!.text.includes(cue.word))throw Error(`Sound anchor missing in ${scene.seg}`);
    if(new Set(scene.sound.cues.map(c=>c.id)).size!==scene.sound.cues.length)throw Error('Duplicate sound cue');
  }
  const ranked=plan.candidates.filter(c=>c.suitable).map(c=>({...c,score:METRICS.reduce((v,k)=>v+c.scores[k]*settings.weights[k],0)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const selected=settings.mode==='manual'?ranked.find(c=>c.id===settings.manual_style):ranked[0];
  if(!selected)throw Error('No compatible installed style; adjust the plan');
  return {selected,alternatives:ranked.filter(c=>c.id!==selected.id),low_confidence:selected.confidence<.65,plan,cache_key:hash({script,settings,plan}),weights:settings.weights};
}
export function creativePrompt(settings:CreativeSettingsT){return `\nCREATIVE MOTION v1: Include a creative object in plan_story in the SAME planning call. No extra style request. Analyze the actual complete story, not keywords or randomness. Explain all user-facing reasons and scene directions in Thai. In each regular storyboard shot also include subjects [{id,description}] naming the concrete subjects. Schema: analysis {genre,arc,tone,audience,hook,factual_density,complexity,characters,locations,metaphors,pacing,identity,brand,budget,capabilities}, candidates [{id,scores:{relevance,storytelling,emotion,characters,continuity,feasibility},confidence,reasons:[text],suitable}], identity {direction,palette:[hex],typography,camera,motion,characters,locations,props,lighting,transitions}, scenes [{seg,objective,shot,camera,composition,elements:[text],emotion,location,characters:[name],transition,events:[{at:0..1,action}],sound:{decision:effects|ambience|silence,reason,cues:[{id,word:EXACT narration anchor,occurrence:0,offset:0,action,prompt,duration:0.5..30,gain:0..0.6}]}}]. Scores/confidence 0..1. Describe ALL analysis fields substantively. At least two motivated motion events per scene. One stable film identity. Every scene needs a sound decision, deliberate silence has empty cues. Avoid repetitive whooshes, no automatic music or image generation. No invented statistics, evidence or medical claims. Only installed styles: ${JSON.stringify(LEMO_STYLES)}. Settings: ${JSON.stringify(settings)}. ${settings.engine==='lemo'?'LEMO OVERRIDE: After plan_story, submit_episode with title_th, angle, sources, claims and captions only; do NOT call drawing tools or write Python. The separate isolated coding worker renders after owner approval.':''}`;}
export function releaseGates(env:NodeJS.ProcessEnv=process.env){
  const library=env.LEMO_STYLE_LIBRARY||'cloudbath-original-v1';
  const permission=library==='cloudbath-original-v1'?['LEMO_ORIGINAL_STYLE_VERIFIED']:library==='owner-films'?['LEMO_FILM_USE_APPROVED','LEMO_PRIVATE_OWNER_MODE']:['LEMO_LICENSE_APPROVED'];
  const names=[...permission,'LEMO_SECURITY_VERIFIED','LEMO_RENDER_VERIFIED','LEMO_V4_VERIFIED','LEMO_SFX_V3_VERIFIED','LEMO_THAI_SYNC_VERIFIED','LEMO_COST_VERIFIED','LEMO_CLASSIC_REGRESSION_VERIFIED'];
  const blockers=names.filter(k=>env[k]!=='true');if(!['cloudbath-original-v1','owner-films','upstream-licensed'].includes(library))blockers.push('LEMO_STYLE_LIBRARY');
  return {enabled:env.LEMO_ENABLED==='true'&&!blockers.length,blockers,development:env.LEMO_DEVELOPMENT==='true',style_library:library};
}
export const CATEGORIES=['planning','style','coding','narration','sfx','music','compute','other'] as const;
export function estimateCreative(row:any,pkg:any,rates:Record<string,any>={}){
  const chars=pkg.script.reduce((n:number,s:any)=>n+Array.from(s.text).length,0),sec=pkg.sfx.reduce((n:number,s:any)=>n+s.duration,0);
  const quantities:Record<string,number>={planning:0,style:0,coding:row.creative.engine==='lemo'?pkg.script.length*2:0,narration:chars,sfx:sec,music:pkg.music?.source==='generate'?1:0,compute:1,other:0};
  const models:Record<string,string|undefined>={coding:row.model,narration:pkg.voice?.model_id,sfx:pkg.sfx[0]?.model_id,music:pkg.music?.model_id,compute:row.creative.engine==='lemo'?'canvas2d':'classic'};
  const items=CATEGORIES.map(category=>{const rate=rates[category],quantity=quantities[category];const valid=rate&&rate.model===models[category]&&(!rate.valid_until||Date.parse(rate.valid_until)>Date.now())&&typeof rate.usd_per_unit==='number'&&Number.isFinite(rate.usd_per_unit)&&rate.usd_per_unit>=0&&typeof rate.source==='string'&&rate.source.trim()&&typeof rate.checked_at==='string'&&!Number.isNaN(Date.parse(rate.checked_at));return {category,quantity,unit:{planning:'already incurred',style:'included in planning',coding:'bounded code attempts',narration:'characters',sfx:'seconds',music:'track',compute:'job',other:'none'}[category],estimated_usd:quantity===0?0:valid?quantity*rate.usd_per_unit:null,rate:valid?rate:null,note:category==='planning'?'Planning already incurred; actual provider token usage shown separately':category==='style'?'Included in story planning; explicit regeneration needs a new approval':''};});
  return {revision:hash({draft:row.draft,storyboard:row.storyboard,creative:row.creative,source_text:row.source_text}),items,known_total_usd:items.reduce((n,i)=>n+(i.estimated_usd||0),0),unknown:items.filter(i=>i.estimated_usd===null).map(i=>i.category),planning_usage:row.usage||{},currency:'USD'};
}
