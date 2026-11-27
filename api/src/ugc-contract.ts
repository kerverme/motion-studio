import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_OPENAI_MODEL, DEFAULT_REASONING } from './openai-models.js';
import { digest } from './text-video-contract.js';
import { chooseGenerationSeconds, compileProductMotion } from './video-director.js';
import { H3_MAX_IMAGE, PREVIOUS_FRAME, getVideoModel, buildVideoPayload, estimateVideoPayload, type FalVideoModel } from './video-registry.js';

export const uuid = z.string().uuid();
const short = (size: number) => z.string().trim().max(size);
const url = z.string().trim().max(2048).url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password;
}, 'ใช้ URL https ที่ไม่มีข้อมูลล็อกอิน');
export const Evidence = z.object({ url, title: short(350), date: short(40), quote: short(350),
  kind: z.enum(['demand', 'commerce']) }).strict();
const Product = z.object({
  name: short(140), variant: short(80), price: z.union([z.literal(''), short(32).regex(/^\d{1,9}(?:\.\d{1,2})?$/)]),
  promo: short(100), selling_points: short(1400), order_url: z.union([z.literal(''), url]),
}).strict();
export const Hook = z.string().trim().min(2).max(85).regex(/[ก-๙]/u, 'Hook ต้องมีข้อความภาษาไทย');
const Voice = z.string().trim().min(2).max(160).regex(/[ก-๙]/u, 'บทพูดต้องมีข้อความภาษาไทย');
export const Scene = z.object({
  id: z.string().regex(/^shot_[0-9]{2}$/), seconds: z.number().int().min(2).max(15),
  narration: Voice, subtitle: short(160).default(''), visual: short(900).min(5), camera: short(125).min(2),
  mode: z.enum(['original', 'fal']), media_id: uuid.nullable(),
}).strict();
const CTA = short(40).min(2);
export const Document = z.object({
  product: Product, brief: short(1600), model: short(100).min(1),
  reasoning: z.enum(['low','medium','high']), endpoint: short(230), resolution: short(24),
  duration: z.number().int().min(8).max(30), hooks: z.array(Hook).max(3), hook: z.union([z.literal(''), Hook]),
  caption: short(500), cta: CTA, scenes: z.array(Scene).max(10), show_price: z.boolean(), show_promo: z.boolean(),
}).strict();
export type DraftDocument = z.infer<typeof Document>;
export type Shot = z.infer<typeof Scene>;
export const blank = (name = ''): DraftDocument => ({
  product: {name, variant:'', price:'', promo:'', selling_points:'', order_url:''}, brief:'',
  model:DEFAULT_OPENAI_MODEL, reasoning:DEFAULT_REASONING, endpoint:H3_MAX_IMAGE, resolution:'768P', duration:20,
  hooks:[], hook:'', caption:'', cta:'กดสั่งซื้อ', scenes:[], show_price:true, show_promo:true,
});
export const Suggestion = z.object({
  hooks: z.tuple([Hook,Hook,Hook]), caption: short(500), scenes: z.array(Scene.omit({id:true, media_id:true, subtitle:true})).min(2).max(10),
}).strict();
export const falEndpoints = [
  H3_MAX_IMAGE,
  'minimax/h3/image-to-video',
  'xai/grok-imagine-video/v1.5/image-to-video',
  'alibaba/wan-3.0/image-to-video',
  'google/gemini-omni-flash/v1.1/image-to-video',
] as const;
export const videoProvider = { model:getVideoModel, build:buildVideoPayload, price:estimateVideoPayload };
export type Media = {id:string;kind:'image'|'video';storage_key:string;content_type:string};
export type VoiceOffer = {
  voice_id:string; voice_model:'eleven_v3'|'eleven_v4'; voice_usd_per_1000_characters:number;
  capabilities_checked_at:number; audio_pricing_source:string; fal:boolean;
};

export function validateClaims(d: Pick<DraftDocument,'product'>, lines: string[]) {
  const facts=Object.values(d.product).slice(0,5).join(' ').normalize('NFKC');
  for (const raw of lines) {
    const line=raw.normalize('NFKC');
    if (/ถูก(?:ที่)?สุด|ดีที่สุด|อันดับหนึ่ง|รีวิวจากลูกค้า|ลูกค้า(?:บอก|รีวิว|ยืนยัน)|รักษาหาย|ขายดีอันดับ/iu.test(line))
      throw Error('ตัดรีวิวลูกค้า คำกล่าวอ้างทางการแพทย์ หรือคำเปรียบเทียบที่ยังไม่มีหลักฐาน');
    const claims = line.match(/ส่ง(?:ได้)?(?:วันนี้|ทันที|ฟรี)|จัดส่งฟรี|มี(?:สินค้าใน)?สต็อก|พร้อมส่ง|เหลือไม่กี่ชิ้น|รับประกัน|ซื้อ\s*\d+\s*แถม\s*\d+|\d+(?:\.\d+)?\s*(?:บาท|%|เปอร์เซ็นต์)/gu) || [];
    if (claims.some(claim=>!facts.includes(claim))) throw Error('พบราคา โปร สต็อก หรือการจัดส่งที่ร้านยังไม่ได้ระบุ');
  }
}

export function validateDocument(d: DraftDocument, media: Media[], evidence: {url:string}[]) {
  const p = d.product;
  if (!p.name || !p.price || Number(p.price)<=0 || !p.order_url)
    throw Error('กรอกชื่อ ราคา และ URL สั่งซื้อของร้านก่อนคิดราคา');
  if (evidence.some(e => new URL(e.url).href === new URL(p.order_url).href))
    throw Error('ระบุ URL สั่งซื้อของร้านแยกจากลิงก์หลักฐานเทรนด์');
  validateClaims(d,[d.hook,d.caption,d.cta,d.product.promo,...d.scenes.flatMap((s,i)=>i?[s.narration,s.subtitle]:[s.subtitle])]);
  if (d.scenes.length<2 || !d.hook || d.scenes.reduce((total, s)=>total+s.seconds,0)!==d.duration)
    throw Error('เลือก Hook และตรวจให้เวลาทุกฉากรวมตรงกับความยาวคลิป (สูงสุด 30 วิ)');
  if (d.scenes[0].seconds<3 || d.scenes[0].seconds>5 || d.scenes[0].mode!=='original' || d.scenes.at(-1)?.mode!=='original')
    throw Error('เปิดคลิป 3–5 วินาทีและปิด CTA ด้วยภาพสินค้าจริง');
  if (new Set(d.scenes.map(s=>s.id)).size!==d.scenes.length) throw Error('พบเลขฉากซ้ำ');
  for (const [i,s] of d.scenes.entries()) {
    if (!media.some(m=>m.id===s.media_id)) throw Error('เลือกสื่ออ้างอิงให้ฉาก '+(i+1));
    const line=i===0 ? d.hook : s.narration;
    if ([...line].length>s.seconds*12) throw Error('ย่อบทพูดฉาก '+(i+1)+' ให้พอดีกับเวลา');
  }
}

export function reuseKey(item: Record<string, any>) {
  if (item.slot.startsWith('eleven:')) return digest({text:item.text,voice:item.voice_id,model:item.model_id});
  return digest({endpoint:item.endpoint_id,payload:item.payload,media:item.media_id,edited:item.edited_seconds});
}

export async function videoItem(model: FalVideoModel, shot: Shot, resolution: string, providers=videoProvider) {
  const seconds = chooseGenerationSeconds(model.durations,shot.seconds);
  if (!model.available || !seconds || seconds>30) throw Error(model.reason || 'รุ่นนี้ยังไม่รองรับความยาวที่เลือก');
  const prompt=compileProductMotion(model,shot.visual,shot.camera,shot.seconds,seconds);
  const payload=providers.build(model,{prompt,duration:seconds,resolution,audio:false,image_url:PREVIOUS_FRAME,aspect_ratio:'9:16'});
  const rate=await providers.price(model,payload);
  if (!(rate.usd>0 && Number.isFinite(rate.usd) && rate.quantity>0)) throw Error('ตรวจราคาฉากของ fal.ai ไม่สำเร็จ');
  return {
    slot:'fal:'+shot.id, scene_id:shot.id, endpoint_id:model.endpoint_id, model_name:model.name, resolution,
    schema_hash:model.schema_hash, payload, media_id:shot.media_id, generation_seconds:seconds,
    edited_seconds:shot.seconds, billed_seconds:/^seconds?$/i.test(rate.unit)?rate.quantity:null,
    billing_quantity:rate.quantity, billing_unit:rate.unit, unit_usd:rate.usd/rate.quantity,
    account_unit_usd:model.price?.unit_price, estimated_usd:rate.usd, native_audio:false, pricing_checked_at:model.checked_at,
    pricing_source:'https://fal.ai/models/'+model.endpoint_id,
  };
}

export function makeQuote(revision:string, d:DraftDocument, media:Media[], fal:any[], voice:VoiceOffer, reused:string[], now=Date.now()) {
  const plan={shots:d.scenes.map((s,i)=>({...s,narration:i===0?d.hook:s.narration}))};
  const input={ugc:true,duration:d.duration,resolution:'1080p'};
  const eleven=plan.shots.map(s=>{
    const characters=[...s.narration].length, credits=Math.ceil(characters*1.1);
    return {slot:'eleven:'+s.id,text:s.narration,characters,credits,voice_id:voice.voice_id,
      model_id:voice.voice_model,usd_per_1000_characters:voice.voice_usd_per_1000_characters,
      estimated_usd:Math.ceil(credits*voice.voice_usd_per_1000_characters*1000)/1e6};
  });
  const pending=(item:{slot:string})=>!reused.includes(item.slot);
  const sum=(items:{slot:string;estimated_usd:number}[])=>Math.ceil(items.filter(pending).reduce((n,x)=>n+x.estimated_usd,0)*1e6-1e-8)/1e6;
  const falUsd=sum(fal), voiceUsd=sum(eleven);
  return { id:randomUUID(),revision,document_hash:digest(d), plan_hash:digest({input,plan}),input,plan,
    media:media.filter(m=>d.scenes.some(s=>s.media_id===m.id)),fal,eleven,reused,
    pending_slots:[...fal,...eleven].filter(pending).map(item=>item.slot),
    currency:'USD',voice_id:voice.voice_id,voice_model:voice.voice_model,voice_pricing_source:voice.audio_pricing_source,
    voice_checked_at:new Date(voice.capabilities_checked_at*1000).toISOString(),fal_usd:falUsd,eleven_usd:voiceUsd,
    editing_usd:0,total_usd:Math.round((falUsd+voiceUsd)*1e6)/1e6,
    created_at:new Date(now).toISOString(),expires_at:new Date(now+10*60_000).toISOString()};
}

export function quoteBinding(q: ReturnType<typeof makeQuote>) {
  return digest({revision:q.revision,document_hash:q.document_hash,media:q.media,voice:q.eleven,reused:q.reused,
    fal:q.fal.map(({pricing_checked_at,...item})=>item),total:q.total_usd});
}
