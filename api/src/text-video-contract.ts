import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {SOURCE_TEXT_LIMIT,parseNarration} from './narration.js';

// Verified schemas and published resolution-specific prices, 2026-11-12.
// The generic fal unit price is NOT the configuration's price (Grok reports $0.01).
export const VIDEO_MODELS = [
  {id:'h3_max',label:'H3 Max',t2v:'minimax/h3-max/text-to-video',i2v:'minimax/h3-max/image-to-video',
    resolutions:['480P','768P','1080P'],rates:{'480P':.05,'768P':.08,'1080P':.16},reference_usd:0,billed_seconds:16,baseline:.035},
  {id:'grok_15',label:'Grok Imagine Video 1.5',t2v:'xai/grok-imagine-video/v1.5/text-to-video',i2v:'xai/grok-imagine-video/v1.5/image-to-video',
    resolutions:['480p','720p','1080p'],rates:{'480p':.08,'720p':.14,'1080p':.25},reference_usd:.01,billed_seconds:15,baseline:.01},
] as const;
export const videoModel=(id:string)=>{const m=VIDEO_MODELS.find(x=>x.id===id);if(!m)throw new Error('โมเดลวิดีโอไม่รองรับ');return m;};
export const VideoInput=z.object({
  topic:z.string().trim().min(3).max(400),source_text:z.string().max(SOURCE_TEXT_LIMIT).default(''),note:z.string().max(2000).default(''),
  model:z.string().default('gpt-6.1-sol'),reasoning:z.enum(['low','medium','high']).default('medium'),
  video_model:z.enum(['h3_max','grok_15']).default('h3_max'),resolution:z.string().default('768P'),
  duration:z.union([z.literal(60),z.literal(90),z.literal(120)]).default(60),
  narration_style:z.string().default('standard'),narration_custom:z.string().max(1000).default(''),
}).strict();
export type VideoInputT=z.infer<typeof VideoInput>;
export function parseVideoInput(raw:unknown){const x=VideoInput.parse(raw);parseNarration(x);if(!(videoModel(x.video_model).resolutions as readonly string[]).includes(x.resolution))throw new Error('ความละเอียดไม่ตรงกับโมเดลที่เลือก');return x;}
const Source=z.object({url:z.string().url(),title:z.string().min(1).max(300),publisher:z.string().max(150),published:z.string().max(150),claim:z.string().max(1000)}).strict();
export const VideoPlan=z.object({
  title:z.string().trim().min(2).max(120),synopsis:z.string().min(10).max(1500),kind:z.enum(['educational','fiction']),
  visual_bible:z.string().min(20).max(2000),sources:z.array(Source).max(8),
  shots:z.array(z.object({id:z.string().regex(/^shot_[0-9]{2}$/),narration:z.string().trim().min(10).max(165),
    visual_prompt:z.string().trim().min(30).max(2400),end_frame:z.string().min(10).max(800),source_ids:z.array(z.number().int().min(0)).max(8)}).strict()).min(4).max(8),
}).strict();
export type VideoPlanT=z.infer<typeof VideoPlan>;
export function validateVideoPlan(raw:unknown,input:VideoInputT){const p=VideoPlan.parse(raw);if(p.shots.length!==input.duration/15)throw new Error('จำนวนช็อตต้องตรงกับความยาวที่เลือก (ช็อตละ 15 วินาที)');
  if(p.shots.some((s,i)=>s.id!==`shot_${String(i+1).padStart(2,'0')}`))throw new Error('ลำดับช็อตไม่ถูกต้อง');
  if(p.shots.some(s=>s.source_ids.some(i=>i>=p.sources.length)))throw new Error('เลขอ้างอิงไม่ตรงกับแหล่งข้อมูล');
  if(p.kind==='educational'&&(!p.sources.length||!p.shots.some(s=>s.source_ids.length)))throw new Error('เรื่องข้อเท็จจริงต้องมีแหล่งข้อมูลที่ตรวจสอบแล้ว');
  if(input.video_model==='grok_15'&&p.shots.some(s=>p.visual_bible.length+s.visual_prompt.length+s.end_frame.length+320>4096))throw new Error('คำสั่งภาพยาวเกินขีดจำกัด Grok กรุณาย่อรายละเอียดภาพ');return p;}
export function digest(v:unknown):string {const stable=(x:any):string=>Array.isArray(x)?'['+x.map(stable).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':JSON.stringify(x);return createHash('sha256').update(stable(v)).digest('hex');}
export const money=(n:number)=>Math.max(0,Math.ceil((n-1e-10)*10000)/10000);
export type Rate={endpoint_id:string;unit:string;unit_price:number;currency:string};
export function makeVideoQuote(input:VideoInputT,plan:VideoPlanT,revision:string,voiceId:string,elevenRate:number,calls:any[],rates:Rate[],now=Date.now()){
  if(!Number.isFinite(elevenRate)||elevenRate<0||elevenRate>100)throw new Error('ใส่ราคา USD ต่อ 1,000 เครดิต ElevenLabs ตามแพ็กเกจของคุณ');
  const m=videoModel(input.video_model);const latest=new Map<string,any>();for(const c of calls)if(!latest.has(c.slot))latest.set(c.slot,c);
  if([...latest.values()].some(c=>c.status==='submitting'||c.status==='unknown'))throw new Error('มีคำขอที่ยังไม่ทราบผล ต้องตรวจ request เดิมก่อนอนุมัติการจ่ายเพิ่ม');
  const pending=plan.shots.flatMap((s,i)=>['fal','eleven'].flatMap(provider=>{const slot=`${provider}:${s.id}`,c=latest.get(slot);return c&&['done','accepted'].includes(c.status)?[]:[{slot,provider,index:i,characters:Array.from(s.narration).length}];}));
  const rate=(endpoint:string)=>{const r=rates.find(r=>r.endpoint_id===endpoint);if(!r||r.currency!=='USD'||r.unit!=='seconds'||!Number.isFinite(r.unit_price)||r.unit_price<=0)throw new Error('ยังยืนยันหน่วยราคาของ fal.ai ไม่ได้ จึงยังส่งผลิตไม่ได้');return r;};
  const live=[rate(m.t2v),rate(m.i2v)];
  // Public standard rates are used as a conservative estimate, not promotional base units.
  const published=(m.rates as Record<string,number>)[input.resolution];
  const perSecond=published*Math.max(1,...live.map(r=>r.unit_price/m.baseline));
  const fal=pending.filter(x=>x.provider==='fal').map(x=>({slot:x.slot,endpoint:x.index?m.i2v:m.t2v,duration:15,billed_seconds:m.billed_seconds,usd:money(perSecond*m.billed_seconds+(x.index?m.reference_usd:0))}));
  const eleven=pending.filter(x=>x.provider==='eleven').map(x=>({slot:x.slot,characters:x.characters,credits:Math.ceil(x.characters*1.10)}));
  const credits=eleven.reduce((n,x)=>n+x.credits,0),falUsd=money(fal.reduce((n,x)=>n+x.usd,0)),elevenUsd=money(credits/1000*elevenRate);
  return {id:randomUUID(),revision,plan_hash:digest({input,plan}),created_at:new Date(now).toISOString(),expires_at:new Date(now+15*60_000).toISOString(),
    currency:'USD',fal_usd:falUsd,eleven_usd:elevenUsd,total_usd:money(falUsd+elevenUsd),eleven_credits:credits,eleven_usd_per_1000_credits:elevenRate,
    voice_id:voiceId,voice_model:'eleven_v3',fal_rates:live,fal,eleven,
    pricing_source:`https://fal.ai/models/${m.t2v}`,pricing_verified:'2026-11-12',
    note:'ประมาณการตามโมเดล/ความละเอียด รวมภาพต่อเฟรมแล้ว ใช้ราคามาตรฐานแทนส่วนลดชั่วคราว H3 เผื่อผลลัพธ์ยาวเกิน 15 วินาทีเล็กน้อย ค่า ElevenLabs ใช้อัตราต่อเครดิตที่คุณระบุ บิลจริงขึ้นกับผู้ให้บริการ ไม่รวมค่าสมอง OpenAI ที่ใช้วางบทแล้ว ไม่มีการสร้างเพลงหรือ SFX แบบเสียเงินเพิ่ม'};
}
