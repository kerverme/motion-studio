import { currentReverseRate } from './reverse-rate.js';
import { promptRate } from './reverse-prompts.js';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { VideoInput, VideoPlan, digest, money } from './text-video-contract.js';
import { parseNarration } from './narration.js';
import { readVideoArena } from './video-arena.js';
import { directVideoScene, StoryBibleSchema, SceneDirectionSchema, chooseGenerationSeconds } from './video-director.js';
import { PREVIOUS_FRAME, getVideoModel, buildVideoPayload, validateVideoPayload, estimateVideoPayload, type FalVideoModel, type VideoCategory } from './video-registry.js';

const Input = VideoInput.omit({video_model:true}).extend({
  engine_version:z.literal(2),routing_mode:z.enum(['best_value','best_quality','within_budget','manual']).default('best_value'),
  budget_usd:z.number().finite().positive().max(10000).default(5),resolution:z.string().trim().min(2).max(24).default('720p'),
  manual_endpoint:z.string().max(240).optional(),
});
export type ProductionInput = z.infer<typeof Input>;
export function parseProductionInput(raw:unknown) {
  const input=Input.parse(raw); parseNarration(input);
  if(input.routing_mode==='manual' && !input.manual_endpoint) throw new Error('กรุณาเลือกโมเดลจาก Arena สำหรับโหมดเลือกเอง');
  return input;
}
const shotSchema=VideoPlan.shape.shots.element.extend({direction:SceneDirectionSchema,production:z.unknown().optional(),narration:z.string().trim().min(1).max(400)});
const planSchema=VideoPlan.extend({story_bible:StoryBibleSchema,sources:z.array(VideoPlan.shape.sources.element.extend({supporting_quote:z.string().max(1400).optional()})).max(8),shots:z.array(shotSchema).min(1).max(32),evidence:z.array(z.unknown()).optional()});
export function parseProductionPlan(raw:unknown,input:ProductionInput) {
  const p=planSchema.parse(raw);
  if(p.shots.some((s,i)=>s.id!==`shot_${String(i+1).padStart(2,'0')}` || s.source_ids.some(j=>j>=p.sources.length))) throw new Error('ตรวจลำดับฉากและหมายเลขอ้างอิง');
  if(p.kind==='educational' && (!p.sources.length || !p.shots.some(s=>s.source_ids.length))) throw new Error('เรื่องข้อเท็จจริงต้องมีแหล่งอ้างอิงของฉาก');
  if(p.shots.reduce((sum,s)=>sum+s.direction.duration_seconds,0)>input.duration) throw new Error('ความยาวรวมของฉากเกินขีดจำกัดที่เลือก');
  return p;
}
const reference=z.string().url().refine(s=>{ const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password; },'กรอกลิงก์ HTTPS สำหรับสื่ออ้างอิง');
const editsSchema=z.object({endpoint_id:z.string().max(240).optional(),prompt:z.string().min(1).max(20000).optional(),original_prompt:z.string().min(1).max(10000).optional(),prompt_mode:z.enum(['optimized','original','manual']).default('optimized'),
  duration:z.number().int().min(1).max(60).optional(),edited_duration:z.number().positive().max(60).optional(),resolution:z.string().min(1).max(24).optional(),quantity:z.number().int().min(1).max(4).default(1),audio:z.boolean().default(false),approve_resolution:z.boolean().default(false),reference_url:z.union([reference,z.literal('')]).optional(),sfx:z.object({text:z.string().trim().min(1).max(500),duration_seconds:z.number().min(.5).max(22)}).nullable().optional()});
export {PREVIOUS_FRAME};
export const productionProviders={arena:readVideoArena,model:getVideoModel,direct:directVideoScene,estimate:estimateVideoPayload,build:buildVideoPayload,validate:validateVideoPayload};
export type ProductionProviders=typeof productionProviders;
type ArenaSnapshot=Awaited<ReturnType<typeof readVideoArena>>;
function currentRanked(arena:ArenaSnapshot) {
  const models=new Map<string,FalVideoModel & {rank:number;rank_category:string}>();
  for(const board of arena.categories) {
    if(board.stale || board.error || !board.last_success_at) continue;
    for(const row of board.models) {
      if(row.rank<1 || row.rank>10) continue;
      for(const model of [row.fal,(row as {video_to_video?:FalVideoModel|null}).video_to_video]) {
        if(!model?.available) continue;
        // Ranked rows can share one endpoint at distinct measured resolutions. Keep each actual ranked configuration.
        const key=model.category==='video-to-video'?model.endpoint_id:digest([model.endpoint_id,board.category,row.rank,model.resolutions]);
        if(!models.has(key)) models.set(key,{...model,rank:row.rank,rank_category:board.category});
      }
    }
  }
  return [...models.values()];
}
export async function bindSourceClip(url:string,request=fetch) {
  const source=new URL(url);
  if(source.protocol!=='https:' || source.username || source.password || source.port || !/(^|\.)fal\.media$/i.test(source.hostname)) throw new Error('ใช้ไฟล์วิดีโอต้นทาง HTTPS บน fal.media เท่านั้น');
  const max=100*1024*1024,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
  try {
    const response=await request(url,{signal:controller.signal,redirect:'error'});
    if(!response.ok || !response.body || Number(response.headers.get('content-length')||0)>max) throw new Error('เปิดวิดีโอต้นทางไม่ได้หรือไฟล์เกิน 100 MiB');
    let size=0;const hash=createHash('sha256'),reader=response.body.getReader();
    for(;;) {const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>max) throw new Error('ไฟล์ต้นทางเกิน 100 MiB');hash.update(chunk.value);}
    if(!size) throw new Error('ไฟล์วิดีโอต้นทางว่าง');
    return hash.digest('hex');
  } finally {controller.abort();clearTimeout(timer);}
}
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
function media(category:VideoCategory,index:number,url?:string) {
  if(category==='image-to-video') {
    if(!url && index===0) throw new Error('ฉากแรกที่ใช้โมเดลภาพเป็นวิดีโอต้องมีภาพอ้างอิง');
    return {image_url:url || PREVIOUS_FRAME};
  }
  if(category==='video-to-video'||category==='video-editing') {
    if(!url) throw new Error('โมเดลแก้ไขวิดีโอต้องมีลิงก์วิดีโออ้างอิง');
    return {video_url:url};
  }
  if(url) throw new Error('โมเดลแปลงข้อความไม่รองรับสื่ออ้างอิงที่เลือก');
  return {};
}
// A single planning or quote operation can reuse verified estimates for identical billable inputs.
// All supported contracts currently price output units plus media inputs; token-priced models are disabled by the registry.
function requestEstimates(providers:ProductionProviders) {
  const memo=new Map<string,ReturnType<ProductionProviders['estimate']>>();
  return (model:FalVideoModel,payload:Record<string,unknown>,duration:number)=>{
    const {prompt,...billable}=payload;
    providers.validate(model,payload);
    const key=digest([model.endpoint_id,model.schema_hash,model.price,billable,duration]);
    if(!memo.has(key)) memo.set(key,providers.estimate(model,payload,1,fetch,duration));
    return memo.get(key)!;
  };
}
export async function prepareProduction(pool:pg.Pool,input:ProductionInput,raw:unknown,previous?:any,providers=productionProviders) {
  const plan=parseProductionPlan(raw,input);
  const arena=await providers.arena(pool);
  const ranked=currentRanked(arena);
  const soundOffer=(await pool.query("SELECT data FROM integrations WHERE provider='text_video_worker' AND updated_at>now()-interval '2 minutes'")).rows[0]?.data;
  let remaining=input.budget_usd, editedTotal=0;
  const estimate=requestEstimates(providers);
  const scenes=[];
  for(const [index,scene] of plan.shots.entries()) {
    const previousScene=previous?.shots?.find((s:any)=>s.id===scene.id);
    const previousProduction=previousScene?.production;
    const edit=editsSchema.parse(previous ? scene.production || {} : {});
    const inheritedOriginal=previousScene && edit.original_prompt===previousScene.visual_prompt && previousProduction?.original_prompt===previousScene.visual_prompt;
    const original=inheritedOriginal?scene.visual_prompt:edit.original_prompt || scene.visual_prompt;
    const resolution=edit.resolution || input.resolution, edited=edit.edited_duration || scene.direction.duration_seconds;
    editedTotal+=edited;
    const sound=!previous && soundOffer?.sfx_models?.length && positive(soundOffer.sfx_credits_per_second) && positive(soundOffer.sfx_usd_per_second) && scene.direction.audio ? {text:scene.direction.audio,duration_seconds:Math.min(4,edited)} : edit.sfx;
    const base={...edit,...(sound?{sfx:sound}:{}),resolution,edited_duration:edited,original_prompt:original};
    // Preserve a manual choice on subsequent edits. Automatic routes may change when the scene or budget changes.
    const manual=edit.endpoint_id && (previousProduction?.endpoint_id!==edit.endpoint_id || previousProduction?.model_override) ? edit.endpoint_id : input.routing_mode==='manual' ? input.manual_endpoint : undefined;
    const category=manual?undefined:index===0 && !edit.reference_url?'text-to-video':'image-to-video';
      const matching=ranked.filter(m=> (!manual || m.endpoint_id===manual) && (!category || m.category===category) && m.resolutions.some(s=>s.toLowerCase()===resolution.toLowerCase()) && (!edit.audio || m.audio===true));
      const attempts=await Promise.allSettled(matching.map(async m=>{
        const seconds=edit.duration && (previousProduction?.duration!==edit.duration || previousProduction.duration_override) ? edit.duration : chooseGenerationSeconds(m.durations,edited);
        if(!seconds||seconds<edited || !m.durations.includes(seconds)) throw new Error('ระยะเวลาที่เลือกไม่รองรับในโมเดลนี้');
        const details=media(m.category,index,edit.reference_url);
        const payload=providers.build(m,{duration:seconds,resolution,prompt:original,audio:edit.audio,aspect_ratio:'9:16',...details});
        const {usd}=await estimate(m,payload,seconds);
        return {...m,generation_seconds:seconds,estimated_usd:usd};
      }));
      const candidates=attempts.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
      const issue=matching.length?message(attempts.find(r=>r.status==='rejected')?.reason || 'ยังยืนยันค่าใช้จ่ายไม่ได้'):'ไม่มีรุ่น Arena Top 10 ที่ตรวจสอบราคาได้และรองรับข้อมูล/ความละเอียดนี้ กรุณาตรวจอันดับหรือเลือกโมเดลและความละเอียดเอง';
      const minimum=candidates.length?Math.min(...candidates.map(c=>c.estimated_usd))*edit.quantity:0;
      scenes.push({index,scene,previousProduction,edit,original,resolution,edited,base,manual,category,candidates,issue,minimum});
  }
  if(editedTotal>input.duration) throw new Error('ความยาวรวมหลังตัดต่อเกินระยะเวลาที่เลือก');
  const out=[];
  if(input.routing_mode==='within_budget') {
    const qa=await inspectionOffer(pool,soundOffer).catch(()=>null);
    for(const {scene,edit,base} of scenes) {
      if(qa) remaining-=qa.estimated_usd_per_variant*edit.quantity;
      if(edit.audio) continue;
      if(positive(soundOffer?.voice_usd_per_1000_characters)) remaining-=money(Math.ceil(Array.from(scene.narration).length*1.10)*soundOffer.voice_usd_per_1000_characters/1000);
      if(base.sfx && positive(soundOffer?.sfx_usd_per_second)) remaining-=money(base.sfx.duration_seconds*soundOffer.sfx_usd_per_second);
    }
  }
  let futureMinimum=scenes.reduce((sum,s)=>sum+s.minimum,0);
  for(const {index,scene,previousProduction,edit,original,resolution,edited,base,manual,category,candidates,issue,minimum} of scenes) {
    futureMinimum-=minimum;
    const available=input.routing_mode==='within_budget'?Math.max(0,remaining-futureMinimum):remaining;
    try {
      if(!candidates.length) throw new Error(issue);
      const directed=await providers.direct(pool,{scene,index,bible:plan.story_bible,candidates,mode:manual?'manual':input.routing_mode,budget_usd:Math.round(available*1e6)/1e6/edit.quantity,resolution,manual_endpoint_id:manual,prompt_mode:edit.prompt_mode==='optimized'?'auto':'original',original_prompt:edit.prompt_mode==='manual' ? (edit.prompt || original) : original,previous_end_frame:!edit.reference_url && candidates[0].category==='image-to-video'?plan.shots[index-1]?.end_frame:undefined,has_explicit_reference:!!edit.reference_url,previous_direction:plan.shots[index-1]?.direction,requires_native_audio:edit.audio,required_category:manual?candidates[0]?.category:category,edited_seconds:edited});
      const model=candidates.find(m=>m.endpoint_id===directed.endpoint_id);
      if(!model) throw new Error('โมเดลที่เลือกไม่อยู่ในผลการตรวจล่าสุด');
      const prompt=edit.prompt_mode==='manual' ? edit.prompt || original : directed.prompt;
      const payload=providers.build(model,{prompt,resolution,duration:model.generation_seconds,audio:edit.audio,aspect_ratio:'9:16',...media(model.category,index,edit.reference_url)});
      providers.validate(model,payload);
      const cost=(await estimate(model,payload,model.generation_seconds)).usd;
      remaining-=cost*edit.quantity;
      const issues=directed.inspection.passed?[]:directed.inspection.issues.map((i:any)=>typeof i==='string'?i:i.message||JSON.stringify(i));
      if(Array.from(scene.narration).length>Math.max(25,22*edited)) issues.push('บทบรรยายยาวเกินช่วงตัดต่อ กรุณาย่อบทหรือเพิ่มเวลาฉาก');
      if(resolution.toLowerCase()!=='720p'&&!edit.approve_resolution) issues.push('ยืนยันความละเอียดทางเลือกของฉากนี้ก่อนส่งผลิต');
      out.push({...scene,production:{...base,prompt,endpoint_id:model.endpoint_id,category:model.category,model_name:model.name,rank:model.category==='video-to-video'?null:model.rank,rank_category:model.rank_category,reason:directed.selection_reason,knowledge_sources:directed.knowledge_sources,prompt_format:directed.prompt_format,knowledge_version:directed.knowledge_version,inspection:directed.inspection,issues,duration:model.generation_seconds,model_override:!!manual,duration_override:!!edit.duration && (previousProduction?.duration!==edit.duration || !!previousProduction?.duration_override),estimated_usd:money(cost*edit.quantity),schema_hash:model.schema_hash}});
    } catch(e) {
      out.push({...scene,production:{...base,endpoint_id:manual || edit.endpoint_id || '',prompt:edit.prompt||original,model_override:!!manual,issues:[message(e)],estimated_usd:null}});
    }
  }
  return {...plan,shots:out};
}

const positive=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0;
export function pendingBySlot(calls:any[]) {
  const latest=new Map<string,any>();
  for(const c of calls) if(!latest.has(c.slot)) latest.set(c.slot,c);
  if([...latest.values()].some(c=>['submitting','unknown'].includes(c.status))) throw new Error('มีคำขอเดิมที่ยังไม่ทราบผล ต้องตรวจผู้ให้บริการก่อนส่งคำขอใหม่');
  return (slot:string)=>!['accepted','done'].includes(latest.get(slot)?.status);
}
async function inspectionOffer(pool:pg.Pool,w:any) {
  if(!w?.qa || !w.qa_model || !w.qa_rate) return null;
  const rate=promptRate(await currentReverseRate(pool,process.env.MOTION_REVERSE_OPENAI_RATE_JSON,w.qa_rate,w.qa_model));
  const max_input_tokens=24000,max_output_tokens=2000;
  const estimated_usd_per_variant=money((max_input_tokens*Math.max(rate.input_per_million,rate.cache_write_per_million||0)+max_output_tokens*rate.output_per_million)/1e6);
  return {model:w.qa_model,rate,max_input_tokens,max_output_tokens,estimated_usd_per_variant};
}
function voiceRate(w:any,selectedRate:unknown) {
  const offered=w.voice_usd_per_1000_characters;
  if(!positive(offered)) throw new Error('ยังไม่ยืนยันราคา API สำหรับโมเดลเสียงที่เลือก');
  const rate=z.number().finite().positive().max(100).parse(offered);
  if(selectedRate!=null && selectedRate!==rate) throw new Error('อัตราค่าเสียงที่ worker ยืนยันเปลี่ยนไป กรุณาตรวจราคาใหม่');
  return rate;
}
function voiceReady(w:any) {
  if(!w?.eleven||!w.voice_id||!w.voice_models?.includes(w.voice_model)) throw new Error('ยังตรวจโมเดล/เสียง ElevenLabs ที่ใช้งานจริงไม่ได้');
}
function requireV2Worker(w:any) {if(!w?.fal || w.production_version!==2) throw new Error('รอ motion-worker ที่รองรับแผนการผลิตรุ่นนี้และเชื่อม fal.ai');}
export async function createProductionQuote(pool:pg.Pool,row:any,opts:any,w:any,calls:any[],previous:any,providers=productionProviders) {
  requireV2Worker(w);
  const input=parseProductionInput(row.request),plan=row.plan;
  const fx=z.number().positive().finite().max(1000).parse(opts.usd_to_thb ?? Number(process.env.MOTION_USD_TO_THB));
  const pending=pendingBySlot(calls),fal:any[]=[],eleven:any[]=[],pending_slots:string[]=[];
  const models=new Map<string,Promise<FalVideoModel>>();
  const estimate=requestEstimates(providers);
  const arena=await providers.arena(pool);
  const ranked=currentRanked(arena);
  const sources=new Map<string,Promise<string>>();
  let voicePrice:number|null=null,qaCost=0,inspection=null,inspection_issue='';
  try {inspection=await inspectionOffer(pool,w);if(!inspection)inspection_issue='ยังไม่มีโมเดลตรวจภาพและราคาที่ยืนยันได้ ต้องตรวจผลงานด้วยตนเอง';}
  catch(e){inspection_issue=message(e);}
  function archived(slot:string,items:any[]) {
    if(pending(slot)) return null;
    const item=items?.find(i=>i.slot===slot);
    if(!item) throw new Error('ไม่พบรายการเดิมที่อนุมัติสำหรับ '+slot);
    return item;
  }
  for(const [index,shot] of plan.shots.entries()) {
    const p=shot.production;
    if(p?.issues?.length || !p?.endpoint_id || !p.knowledge_version || !p.inspection?.passed) throw new Error(`${shot.id} · ${p?.issues?.join(' · ')||'กรุณาแก้แผนและตรวจคำสั่งวิดีโอก่อน'}`);
    const slot='fal:'+shot.id;
    const saved=previous?.fal || [];
    let fresh:any;
    for(let variant=1;variant<=p.quantity;variant++) {
      const id=slot+(variant===1?'':':'+variant);
      let item=archived(id,saved);
      if(item) {
        if(item.endpoint_id!==p.endpoint_id || item.scene_id!==shot.id || item.payload?.prompt!==p.prompt || item.generation_seconds!==p.duration || item.edited_seconds!==p.edited_duration || item.resolution!==p.resolution || item.native_audio!==p.audio || item.reference_url!==(p.reference_url||'')) throw new Error('ฉากที่ใช้ผลเดิมมีข้อมูลเปลี่ยน กรุณาสร้างแผนซ่อมใหม่');
      } else {
        if(!fresh) {
          const rank=ranked.find(m=>m.endpoint_id===p.endpoint_id && m.category===p.category && m.resolutions.some(r=>r.toLowerCase()===p.resolution.toLowerCase()) && (m.category==='video-to-video'?p.rank===null:m.rank===p.rank));
          if(!rank) throw new Error(`${shot.id} · อันดับหรือสถานะโมเดลเปลี่ยน กรุณาบันทึกแผนใหม่`);
          const key=p.category+' '+p.endpoint_id;
          if(!models.has(key)) models.set(key,providers.model(p.endpoint_id,p.category));
          const model=await models.get(key)!;
          if(!model.available || !model.price || model.schema_hash!==p.schema_hash) throw new Error(`${shot.id} · ความสามารถหรือราคาโมเดลเปลี่ยน กรุณาตรวจแผนใหม่`);
          if(model.billing?.source_second_usd!=null && !w.verified_media_trim) throw new Error('รอ worker ที่สามารถตรวจระยะเวลาสื่อต้นทางก่อนสร้างวิดีโอได้');
          let source_clip;
          if(model.billing?.source_second_usd!=null) {
            if(!sources.has(p.reference_url)) sources.set(p.reference_url,bindSourceClip(p.reference_url));
            source_clip={url:p.reference_url,sha256:await sources.get(p.reference_url),seconds:p.duration,field:'video_url'};
          }
          const payload=providers.build(model,{prompt:p.prompt,duration:p.duration,resolution:p.resolution,audio:p.audio,aspect_ratio:'9:16',...media(model.category,index,p.reference_url)});
          providers.validate(model,payload);
          const est=await estimate(model,payload,p.duration);
          if(!positive(est.usd)) throw new Error('ยังยืนยันราคาการสร้างฉากไม่ได้');
          fresh={scene_id:shot.id,endpoint_id:model.endpoint_id,endpoint:model.endpoint_id,model_name:model.name,rank:p.rank,rank_category:rank.rank_category,category:model.category,payload,...(source_clip?{source_clip}:{}),price:model.price,pricing_rules_hash:digest(model.billing||null),raw_estimated_usd:est.usd,price_units:est.quantity,billing_unit:est.unit,generation_seconds:p.duration,edited_seconds:p.edited_duration,duration:p.duration,resolution:p.resolution,native_audio:p.audio,estimated_usd:money(est.usd),usd:money(est.usd),schema_hash:model.schema_hash,knowledge_version:p.knowledge_version,previous_frame:Object.values(payload).includes(PREVIOUS_FRAME),reference_url:p.reference_url||'',quantity:1};
        }
        item={slot:id,...fresh};pending_slots.push(id);
      }
      fal.push(item);
      const qaSlot=id.replace(/^fal:/,'qa:');
      if(inspection && pending(qaSlot) && !(row.repair_from && !pending(id))) {pending_slots.push(qaSlot);qaCost+=inspection.estimated_usd_per_variant;}
    }
    if(p.audio) continue;
    const voiceSlot='eleven:'+shot.id,voice=archived(voiceSlot,previous?.eleven || []);
    if(voice) {
      if(voice.text!==shot.narration) throw new Error('เสียงที่ใช้ผลเดิมมีบทต่างจากเดิม');
      eleven.push(voice);
    } else {
      voiceReady(w);
      if(previous?.eleven?.some((v:any)=>v.slot.startsWith('eleven:') && !pending(v.slot) && (v.voice_id!==w.voice_id || v.model_id!==w.voice_model))) throw new Error('เสียงเดิมของฉากที่ใช้ซ้ำต่างจากเสียงปัจจุบัน กรุณาตรวจเสียงเดิมก่อนซ่อม');
      voicePrice=voiceRate(w,opts.eleven_usd_per_1000_characters);
      const characters=Array.from(shot.narration).length,credits=Math.ceil(characters*1.10);
      eleven.push({slot:voiceSlot,scene_id:shot.id,text:shot.narration,model_id:w.voice_model,voice_id:w.voice_id,characters,credits,usd_per_1000_characters:voicePrice,estimated_usd:money(credits*voicePrice/1000)});pending_slots.push(voiceSlot);
    }
    if(p.sfx) {
      const sfxSlot='sfx:'+shot.id,sound=archived(sfxSlot,previous?.eleven || []);
      if(sound) {
        if(sound.text!==p.sfx.text || sound.duration_seconds!==p.sfx.duration_seconds) throw new Error('เสียงประกอบที่ใช้ผลเดิมต่างจากแผน');
        eleven.push(sound);continue;
      }
      const model_id=w.sfx_models?.[0],{duration_seconds,text}=p.sfx;
      if(!w.eleven||!model_id||!positive(w.sfx_credits_per_second)||!positive(w.sfx_usd_per_second)) throw new Error('ยังไม่มีโมเดลเอฟเฟกต์เสียงและราคาที่ตรวจสอบได้ ปิดเอฟเฟกต์เสียงหรืออัปเดตค่าใช้จ่าย');
      if(duration_seconds>p.edited_duration) throw new Error('เอฟเฟกต์เสียงต้องไม่ยาวเกินฉาก');
      eleven.push({slot:sfxSlot,scene_id:shot.id,model_id,text,duration_seconds,credits:Math.ceil(w.sfx_credits_per_second*duration_seconds),usd_per_second:w.sfx_usd_per_second,estimated_usd:money(w.sfx_usd_per_second*duration_seconds)});pending_slots.push(sfxSlot);
    }
  }
  const due=(items:any[],key:string)=>items.reduce((n,i)=>n+(pending_slots.includes(i.slot)?i[key]||0:0),0);
  const fal_usd=money(due(fal,'estimated_usd')),eleven_usd=money(due(eleven,'estimated_usd')),sfx_usd=money(due(eleven.filter(i=>i.slot.startsWith('sfx:')),'estimated_usd'));
  const total_usd=money(fal_usd+eleven_usd+qaCost),now=Date.now();
  if(input.routing_mode==='within_budget' && total_usd>input.budget_usd) throw new Error(`ค่าใช้จ่าย $${total_usd} เกินงบ $${input.budget_usd} กรุณาแก้แผน`);
  return {id:randomUUID(),version:2,revision:row.revision,plan_hash:digest({input:row.request,plan}),payload_hash:digest({fal,eleven}),fal,eleven,pending_slots,inspection,inspection_issue,
    voice_id:eleven.find(i=>i.slot.startsWith('eleven:'))?.voice_id || w.voice_id || null,voice_model:eleven.find(i=>i.slot.startsWith('eleven:'))?.model_id || w.voice_model || null,fal_rates:fal.map(x=>({endpoint_id:x.endpoint_id,...x.price})),created_at:new Date(now).toISOString(),expires_at:new Date(now+15*60000).toISOString(),currency:'USD',
    fal_usd,eleven_usd,sfx_usd,qa_usd:money(qaCost),total_usd,usd_to_thb:fx,total_thb:money(total_usd*fx),budget_usd:input.budget_usd,remaining_budget_usd:Math.round((input.budget_usd-total_usd)*1e4)/1e4,
    use_project_music:!fal.some(i=>i.native_audio),background_music:fal.some(i=>i.native_audio)?'ใช้มิกซ์เสียงของฉากที่เลือก':'ใช้เพลงเริ่มต้นของโครงการถ้ามี โดยไม่มีค่าเรียกผลิตเพลงเพิ่ม',
    scene_count:plan.shots.length,generated_seconds:fal.reduce((n,x)=>n+x.generation_seconds,0),edited_seconds:plan.shots.reduce((n:number,s:any)=>n+s.production.edited_duration,0),eleven_credits:due(eleven,'credits'),eleven_characters:due(eleven,'characters'),eleven_usd_per_1000_characters:voicePrice,eleven_pricing_source:w.audio_pricing_source||null,sfx_pricing_source:w.sfx_pricing_source||null,research_usage:row.usage||{},research_cost_usd:null,other_processing_usd:null,output_resolution:new Set(fal.map(x=>x.resolution.toLowerCase())).size===1?fal[0].resolution:'720p',
    note:'ราคาเฉพาะคำขอใหม่ รวมยอดตรวจภาพที่คาดไว้ถ้าพร้อมใช้งาน ค่าโครงสร้างพื้นฐานและค่าวางบทที่เกิดขึ้นแล้วแยกจากยอดนี้'};
}
export function quoteBinding(q:any){return digest({plan_hash:q.plan_hash,payload_hash:q.payload_hash,pending_slots:q.pending_slots,inspection:q.inspection,total_usd:q.total_usd,usd_to_thb:q.usd_to_thb,voice_id:q.voice_id,voice_model:q.voice_model});}
export async function verifyProductionSlot(pool:pg.Pool,approval:any,slot:string,w:any,providers=productionProviders) {
  requireV2Worker(w);
  if(!approval.pending_slots?.includes(slot) || approval.payload_hash!==digest({fal:approval.fal,eleven:approval.eleven})) throw new Error('รายการที่ส่งไม่ตรงการอนุมัติ');
  if(slot.startsWith('qa:')) {
    if(!approval.inspection || digest(approval.inspection)!==digest(await inspectionOffer(pool,w))) throw new Error('โมเดลหรือราคาตรวจวิดีโอเปลี่ยน กรุณายืนยันใหม่');
    return;
  }
  if(slot.startsWith('fal:')) {
    const item=approval.fal.find((x:any)=>x.slot===slot);
    if(!item) throw new Error('ไม่พบฉากที่ยืนยันราคา');
    const model=await providers.model(item.endpoint_id,item.category);
    if(!model.available || model.schema_hash!==item.schema_hash || digest(model.price)!==digest(item.price) || digest(model.billing||null)!==item.pricing_rules_hash) throw new Error('ราคา/สคีมาของผู้ให้บริการเปลี่ยน กรุณายืนยันใหม่');
    providers.validate(model,item.payload);
    if(model.billing?.source_second_usd!=null && !w.verified_media_trim) throw new Error('worker ยังไม่ยืนยันการวัดสื่อต้นทาง');
    if(item.source_clip && item.source_clip.sha256!==await bindSourceClip(item.source_clip.url)) throw new Error('ไฟล์ต้นทางเปลี่ยน ต้องคิดราคาและยืนยันใหม่');
    const est=await providers.estimate(model,item.payload,1,fetch,item.generation_seconds);
    if(est.usd!==item.raw_estimated_usd || money(est.usd)!==item.estimated_usd || est.unit!==item.billing_unit || est.quantity!==item.price_units) throw new Error('ราคาคำขอที่ตรวจล่าสุดเปลี่ยน กรุณายืนยันใหม่');
    return;
  }
  const item=approval.eleven.find((x:any)=>x.slot===slot);
  if(!item || !w?.eleven) throw new Error('เสียงที่ส่งไม่ตรงการอนุมัติ');
  if(slot.startsWith('sfx:')) {
    if(!w.sfx_models?.includes(item.model_id) || w.sfx_usd_per_second!==item.usd_per_second || Math.ceil(item.duration_seconds*w.sfx_credits_per_second)!==item.credits) throw new Error('โมเดลหรือค่าเอฟเฟกต์เสียงเปลี่ยน กรุณายืนยันใหม่');
  } else {
    voiceReady(w);
    if(w.voice_model!==item.model_id || w.voice_id!==item.voice_id || voiceRate(w,item.usd_per_1000_characters)!==item.usd_per_1000_characters) throw new Error('เสียงหรืออัตราค่าเสียงเปลี่ยน กรุณายืนยันใหม่');
  }
}
