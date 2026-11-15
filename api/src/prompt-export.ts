/** Pure, provider-free compilation. Source facts and paid evidence are never rewritten. */
import {readFileSync} from 'node:fs';
import {sha} from './reverse-contract.js';
import {catalogModels} from './reverse-catalog.js';
const catalog=JSON.parse(readFileSync(new URL('../config/prompt-export-catalog.json',import.meta.url),'utf8'));
const legacy=JSON.parse(readFileSync(new URL('../config/reverse-fal-catalog.json',import.meta.url),'utf8'));
export const EXPORT_VERSION='motion.fal-prompt.v1';
const variant=(p:any):any=>({...p,...(p?.anyOf||p?.oneOf||[]).find((x:any)=>x.type!=='null')});
const number=(n:number)=>Number(n.toFixed(6)).toString();
function family(id:string){return /minimax\/h3/.test(id)?'h3':/kling/.test(id)?'kling':/seedance/.test(id)?'seedance':/wan/.test(id)?'wan':/ltx/.test(id)?'ltx':'natural';}
export function exportModels(){const costs=catalogModels(5);return catalog.models.map((m:any)=>{const cost=costs.find((x:any)=>x.id===m.endpoint_id);return {id:m.endpoint_id,label:m.name,family:family(m.endpoint_id),schema_available:!!m.schema,checked_at:catalog.checked_at,source:m.source,caveat:m.caveat||null,comparison_usd:cost?.estimate_usd??null,comparison_resolution:cost?.preset_resolution,comparison_checked_at:legacy.checked_at,comparison_note:'Historical 5-second preset comparison, 9:16, audio off; not a quote for this export. Check current price in fal.'};}).sort((a:any,b:any)=>(a.comparison_usd??Infinity)-(b.comparison_usd??Infinity)||a.label.localeCompare(b.label));}
function hasAudio(m:any){const props=m.schema?.properties||{};return ['generate_audio','audio','generate_audio_switch'].some(k=>variant(props[k]).type==='boolean')||family(m.endpoint_id)==='h3'||/with audio|with sound|native audio|synchronized audio/i.test(m.description);}
function settingsFor(m:any,duration:number,source:any,audio:boolean){
 const settings:any={},warnings:string[]=[],blockers:string[]=[],props=m.schema?.properties||{};
 if(!m.schema)return {settings,warnings,blockers:['ยังไม่มี schema ที่ตรวจสอบได้สำหรับ endpoint นี้ เลือกโมเดลอื่น'],duration:null};
 // Only transfer concrete defaults. Never fill mandatory references, voice IDs or LoRAs.
 for(const [key,value] of Object.entries(props)){const p=variant(value);if(p.default!==undefined&&p.default!==null&&!/prompt|url|voice|lora|seed|camera_motion|multi_|sync_mode/.test(key))settings[key]=p.default;}
 for(const key of ['enable_prompt_expansion','enhance_prompt','prompt_optimizer','generate_audio','audio','generate_audio_switch','sound_effect_switch'])if(variant(props[key]).type==='boolean')settings[key]=/audio|sound/.test(key)?audio:false;
 if(props.prompt_expansion_mode&&(/disabled/.test(JSON.stringify(props.prompt_expansion_mode))))settings.prompt_expansion_mode='disabled';
 let chosen:number|null=null;const p=variant(props.duration);
 if(props.duration){
  const options=(p.enum||[]).map((x:any)=>({raw:x,n:Number(String(x).replace(/s$/,''))})).filter((x:any)=>Number.isFinite(x.n)&&x.n>0).sort((a:any,b:any)=>a.n-b.n);
  if(options.length){const o=options.find((x:any)=>x.n>=duration-1e-6);if(o){chosen=o.n;settings.duration=o.raw;}}
  else if(['number','integer'].includes(p.type)&&Number.isFinite(p.maximum)&&Number.isFinite(p.minimum)){chosen=Math.max(p.minimum,p.type==='integer'?Math.ceil(duration-1e-6):duration);if(chosen>p.maximum)chosen=null;else settings.duration=chosen;}
 }else{
  const old=legacy.models.find((x:any)=>x.endpoint_id===m.endpoint_id);
  const o=old?.preset?.duration_options?.find((o:any)=>o.seconds>=duration-1e-6);
  if(o){chosen=o.seconds;for(const [k,v] of Object.entries(o.input))if(props[k])settings[k]=v;}
 }
 if(chosen===null)blockers.push('ช่วงนี้ยาวเกินหรือไม่มีค่าความยาวที่ยืนยันได้ เลือกฉากสั้นลงหรือโมเดลอื่น');
 else if(chosen>duration+1e-6)warnings.push(`โมเดลรับ ${number(chosen)} วินาที: คงการกระทำที่เวลาเดิม แล้วค้างท่าจบ ตัดส่วนเกินหลัง ${number(duration)} วินาทีเองในโปรแกรมตัดต่อ`);
 const ratio=source?.width/source?.height;const aspect=variant(props.aspect_ratio);const ratios=(aspect.enum||[]).filter((x:string)=>/^\d+:\d+$/.test(x));
 if(ratios.length){const exact=ratios.find((x:string)=>{const [w,h]=x.split(':').map(Number);return Math.abs(w/h-ratio)/ratio<.012;});if(exact)settings.aspect_ratio=exact;else{delete settings.aspect_ratio;blockers.push('ไม่สามารถรักษาสัดส่วนภาพต้นฉบับด้วยค่าที่โมเดลรองรับ เลือกโมเดลอื่น');}}
 else {
  const sizes=(props.video_size?.anyOf||[]).flatMap((p:any)=>p.enum||[]);
  const match=sizes.find((name:string)=>{const parts=name.match(/^(portrait|landscape)_(\d+)_(\d+)$/);const r=parts?(parts[1]==='portrait'?Number(parts[3])/Number(parts[2]):Number(parts[2])/Number(parts[3])):name.startsWith('square')?1:NaN;return Math.abs(r-ratio)/ratio<.012;});
  if(match)settings.video_size=match;
  else blockers.push('ยังไม่ยืนยันค่าตั้งที่รักษาสัดส่วนภาพต้นฉบับได้สำหรับโมเดลนี้');
 }
 if(m.endpoint_id==='lightricks/ltx-2.5/text-to-video/pro'&&props.duration&&variant(props.fps).enum?.includes(50))settings.fps=50;
 for(const key of m.schema.required||[])if(key!=='prompt'&&settings[key]===undefined)blockers.push('endpoint นี้ต้องการข้อมูลเพิ่ม: '+key);
 for(const [key,value] of Object.entries(settings)){const p=variant(props[key]);if((p.enum&&!p.enum.includes(value))||(typeof value==='number'&&((p.minimum!=null&&value<p.minimum)||(p.maximum!=null&&value>p.maximum))))blockers.push('ต้องตรวจค่าตั้ง '+key+' ใหม่');}
 if(!props.prompt)blockers.push('endpoint นี้ไม่มีช่อง prompt แบบข้อความ ต้องใช้ workflow เฉพาะ');
 return {settings,warnings,blockers,duration:chosen};
}
function scoped(doc:any,shotId?:string){const shots=shotId?doc.shots.filter((s:any)=>s.id===shotId):doc.shots;if(!shots.length)throw Error('Unknown source shot');const offset=shots[0].start_s;const rel=(n:number)=>Number((n-offset).toFixed(6));return {offset,duration:rel(shots.at(-1).end_s),shots:shots.map((s:any)=>({...s,start_s:rel(s.start_s),end_s:rel(s.end_s),actions:s.actions.map((a:any)=>({...a,t0:rel(a.t0),t1:rel(a.t1)}))}))};}
export function compileExport(doc:any,replacements:any,endpointId:string,source:any,shotId?:string,mainId?:string){
 const m=catalog.models.find((m:any)=>m.endpoint_id===endpointId);if(!m)throw Error('Unknown fal endpoint');
 if(mainId&&!doc.characters.some((c:any)=>c.id===mainId))throw Error('Unknown main character');
 const changed=Object.keys(replacements.characters||{}).filter(id=>replacements.characters[id]!==doc.characters.find((c:any)=>c.id===id)?.description);
 if(changed.length&&!mainId)throw Error('Choose the main character to export B');
 const b={characters:mainId&&replacements.characters[mainId]?{[mainId]:replacements.characters[mainId]}:{},locations:replacements.locations||{}};
 const clip=scoped(doc,shotId),whole=clip.offset===0&&Math.abs(clip.duration-doc.duration_s)<1e-6;
 const audio=doc.audio,speech=whole?audio?.text||'':'';
 const result=settingsFor(m,clip.duration,source,hasAudio(m)&&!!speech);const warnings=result.warnings,blockers=result.blockers;
 if(changed.some(id=>id!==mainId))warnings.push('B สำหรับคัดลอกนี้คืนตัวละครรองตาม A และเปลี่ยนเฉพาะตัวละครหลักที่เลือก');
 if(!audio)warnings.push('ยังไม่ได้ถอดบทพูด ใช้ปุ่มเพิ่มบทพูดก่อนหากต้นฉบับมีเสียงพูด');
 if(audio?.text&&!whole)warnings.push('บทพูดมีเวลาเฉพาะทั้งช่วง จึงยังไม่ใส่ในฉากย่อยนี้ เลือกทั้งช่วง หรือถอดฉากนี้พร้อมเสียงใหม่');
 if(speech&&!hasAudio(m))warnings.push('โมเดลนี้ยังไม่ยืนยันการสร้างเสียง บทพูดแยกไว้ให้คัดลอกเพื่อทำเสียงภายหลัง');
 // Kling v3 explicitly translates other languages to English. Never label it as original-language speech.
 const languages=(audio?.languages||[]).map((l:any)=>typeof l==='string'?l:l.code);
 const languageLimited=/Supports Chinese and English/.test(JSON.stringify(m.schema));
 const audioOK=!!speech&&hasAudio(m)&&!(languageLimited&&(!languages.length||languages.some((l:string)=>!['en','eng','zh','cmn','zho'].includes(l))));
 if(speech&&hasAudio(m)&&!audioOK){warnings.push('รุ่นนี้อาจแปลบทพูดเป็นอังกฤษ จึงแยกบทพูดไว้และปิดเสียงเพื่อรักษาภาษาต้นฉบับ');if('generate_audio'in result.settings)result.settings.generate_audio=false;}
 if(audioOK)warnings.push('บทพูดคงข้อความเดิม แต่ยังไม่ทราบผู้พูดและเวลารายคำ ต้องตรวจเสียงและ lip sync จากผลจริง');
 if(audio?.status!=='no_audio')warnings.push('ยังไม่ได้ถอดดนตรีและเอฟเฟกต์เสียงจากต้นฉบับ');
 if(clip.shots.length>1)warnings.push('หลายฉากใน prompt เดียวอาจเปลี่ยนจังหวะตัด หากต้องการควบคุมมากขึ้น เลือกส่งออกทีละฉาก');
 const fam=family(endpointId);
 if(fam==='h3'&&(clip.shots.some((s:any)=>s.start_s*2%1!==0)||clip.duration<5))warnings.push('ใช้โครง prompt H3 แต่รักษาเวลาต้นฉบับแทนการปัดเวลาหรือเพิ่มฉากตามคำแนะนำเชิงสร้างสรรค์');
 const refs=new Set<string>(JSON.stringify(clip.shots).match(/\[(?:C|L)\d+\]/g)?.map(x=>x.slice(1,-1))||[]);clip.shots.forEach((s:any)=>refs.add(s.location_id));
 const names=(text:string)=>text.replace(/\[C(\d+)\]/g,'Character $1').replace(/\[L(\d+)\]/g,'Location $1');
 const rows=clip.shots.map((s:any,i:number)=>{
  const direction=[`Opening: ${names(s.opening)}`,...s.actions.map((a:any)=>`At ${number(a.t0)}–${number(a.t1)} seconds: ${names(a.text)}`),`Ending: ${names(s.ending)}`,`Camera: ${names(s.camera)}`,`Lighting: ${names(s.lighting)}`,`Visual style: ${names(s.style)}`,`Required props and interactions: ${names(s.props)}`];
  const ordered=fam==='kling'?[direction[0],direction.at(-4),...direction.slice(1,-4),...direction.slice(-3)]:direction;
  return `${fam==='h3'?`[Shot ${i+1}]`: `Shot ${i+1}.`} ${number(s.start_s)}–${number(s.end_s)} seconds, Location ${s.location_id.slice(1)}. ${ordered.join(' ')}`;
 });
 const locks=`Maintain the listed opening pose, screen positions, facing and eyelines, limb motions, contact points, trajectories, speeds, action order, ending pose, camera movement, lighting and shot timings. Do not add actions, cuts, people, props or captions. ${result.duration&&result.duration>clip.duration+1e-6?`After ${number(clip.duration)} seconds, hold the ending pose and framing until ${number(result.duration)} seconds; do not stretch or replay any action.`:''}`.trim();
 const frozen=rows.join('\n\n')+'\n\n'+locks;
 function render(r:any){
  const entities=[...doc.characters.filter((c:any)=>refs.has(c.id)).map((c:any)=>`Character ${c.id.slice(1)}: ${r.characters[c.id]||c.description}.`),...doc.locations.filter((l:any)=>refs.has(l.id)).map((l:any)=>`Location ${l.id.slice(1)}: ${r.locations[l.id]||l.description}.`)].join('\n');
  const languageNames=languages.map((code:string)=>{try{return new Intl.DisplayNames(['en'],{type:'language'}).of(code)||code;}catch{return code;}}).join(' and ');
  const spoken=fam==='h3'&&languageNames?'<d>['+languageNames+'] '+speech+'</d>':JSON.stringify(speech);
  const dialogue=audioOK?`Spoken dialogue, original language, in this order: ${spoken}. Do not translate or add words. Speaker assignment and word timing are unspecified.`:'No invented speech.';
  if(fam==='h3')return `integrated_multimodal_description:\n${entities}\n\n${frozen}\n\n${dialogue}\noverall_soundscape: ${audio?.status==='no_audio'?'Silent source; no dialogue or soundtrack.':'Source ambience and sound effects are unspecified; do not invent a score.'}\nnon_diegetic_music: N/A`;
  // Universal factual craft for endpoints without their own published grammar.
  return `${entities}\n\n${frozen}\n\n${dialogue}`;
 }
 const a=render({characters:{},locations:{}}),bb=render(b),max=variant(m.schema?.properties?.prompt).maxLength;
 if(max&&(Array.from(a).length>max||Array.from(bb).length>max))blockers.push(`ข้อความเกิน ${max} ตัวอักษรของโมเดลนี้ ระบบไม่ตัดการกระทำหรือบทพูดทิ้ง เลือกทีละฉากหรือโมเดลอื่น`);
 if(m.caveat)warnings.push('สถานะในแค็ตตาล็อก fal: '+m.caveat+(m.retires_at?' · '+m.retires_at:''));
 return {compiler:EXPORT_VERSION,endpoint_id:endpointId,model_label:m.name,family:fam,prompt_a:a,prompt_b:bb,settings:result.settings,source_duration_s:clip.duration,generation_duration_s:result.duration,source_offset_s:clip.offset,shot_id:shotId||null,main_character_id:mainId||null,copy_allowed:blockers.length===0,blockers,warnings,dialogue:speech||audio?.text||'',dialogue_in_prompt:audioOK,locked_directions:frozen,locked_directions_hash:sha({clip,locks,audio:audio||null}),schema_hash:sha(m.schema),schema_checked_at:catalog.checked_at,schema_source:m.source,guidance:catalog.guidance,model_url:'https://fal.ai/models/'+endpointId,paid_requests:0,source_uploads:0};
}
