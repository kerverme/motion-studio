import { z } from 'zod';
import { BudgetedFirecrawl, ResearchBudgetError, shopeeProductId } from './firecrawl-budget.js';

import { sourceKey } from './source-evidence.js';

type Listing={id:string;url:string;name:string;shop:string|null;price:string|null;signal:string|null;label:string;checked_at:string;cached:boolean};
const clean=(s:string)=>s.replace(/!\[[^\]]*\]\([^)]+\)/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\*\*/g,'').trim();
export function readListing(url:string,result:{payload:any;collected_at:string;cache_hit:boolean}):Listing|null{
  const page=result.payload?.data,meta=page?.metadata;
  const landing=meta?.url||meta?.sourceURL;
  const id=shopeeProductId(url);
  if(!id||!page?.markdown||shopeeProductId(landing)!==id || (meta.ogUrl||meta['og:url'])&&shopeeProductId(meta.ogUrl||meta['og:url'])!==id ||
     meta.error||Number(meta.statusCode??200)>=400)return null;
  const lines=String(page.markdown).split('\n').map(clean).filter(Boolean);
  const start=lines.findIndex(l=>/^# [^#]/.test(l));
  if(start<0)return null;
  const name=lines[start].slice(2).trim();
  if(name.length<2||name.length>140||/เข้าสู่ระบบ|verify|captcha|page not found|หน้าที่คุณค้นหา|เข้าสู่ Shopee/i.test(name))return null;
  const next=lines.slice(start+1);
  const boundary=next.findIndex(l=>/^## |^การจัดส่ง$|^รายละเอียดสินค้า$|^สินค้าที่คุณอาจ/.test(l));
  const summary=next.slice(0,boundary<0?24:Math.min(boundary,36));
  const sold=summary.find(l=>/^(?:ขายแล้ว\s*[\d,.]+\s*(?:[kKmM]|พัน|หมื่น|แสน|ล้าน)?\+?\s*(?:ชิ้น|รายการ)?|[\d,.]+[kKmM]?\+?\s*sold)$/i.test(l));
  const badge=summary.find(l=>/^(?:สินค้าขายดี|ขายดี|ขายดีอันดับ\s*\d+|อันดับ\s*\d+\s*(?:ในหมวด|ขายดี).{0,60})$/.test(l));
  const prices=summary.filter(l=>/^฿\s*\d[\d,]*(?:\.\d{1,2})?$/.test(l));
  const conditional=summary.some(l=>/โปร|ลูกค้าใหม่|ส่วนลด|คูปอง|ราคาเริ่ม|^[-−]\d+%|฿.*[-–~].*\d/.test(l));
  const price=prices.length===1&&!conditional?prices[0]:null;
  const chat=next.findIndex(l=>l==='แชทเลย');
  const merchant=chat>0?next[chat-1]:'';
  const shop=/^[\p{L}\p{M}\d][\p{L}\p{M}\d _.-]{1,64}$/u.test(merchant)&&!/รถเข็น|^ซื้อสินค้า$/.test(merchant)?merchant:null;
  return {id,url,name,shop,price,signal:[badge,sold].filter(Boolean).join(' · ')||null,
    label:badge?'ขายดีตามป้าย Shopee':sold?'ยอดขายสะสมที่หน้าแสดง':'สินค้าที่พบ',checked_at:result.collected_at,cached:result.cache_hit};
}

const warnings:Record<string,string>={
  budget_exceeded:'เหลืองบไม่พออ่านหน้าถัดไป (เพดาน 25 เครดิต)',busy:'Firecrawl กำลังตรวจงานอื่น',
  uncertain_charge:'ยังยืนยันค่าใช้จ่าย Firecrawl ครั้งก่อนของงานนี้ไม่ได้',no_evidence:'อ่านรายละเอียดสินค้าบางหน้าไม่ได้',
  provider_error:'Firecrawl อ่าน Shopee ไม่สำเร็จ',cost_mismatch:'Firecrawl แจ้งค่าใช้จ่ายต่างจากที่จองไว้',
};
export async function discoverShopee(client:BudgetedFirecrawl,job:string,query:string){
  const evidence:Listing[]=[], notes=new Set<string>();
  const scope={mode:'ugc_shopee'} as const;
  const budget=query.match(/(?:ไม่เกิน|ไม่เกินราคา|งบ(?:ประมาณ)?(?:ไม่เกิน)?)\s*([\d,]+(?:\.\d+)?)\s*บาท/);
  const cap=budget?Number(budget[1].replaceAll(',','')):null;
  const warn=(e:unknown)=>{
    if(!(e instanceof ResearchBudgetError))notes.add('ติดต่อ Firecrawl ไม่สำเร็จ');
    else if(e.httpStatus===402)notes.add('เครดิตบัญชี Firecrawl ไม่เพียงพอ');
    else if(e.httpStatus===429)notes.add('Firecrawl ถึงขีดจำกัดการเรียกชั่วคราว');
    else notes.add(warnings[e.code]??'อ่าน Shopee ไม่สำเร็จ');
  };
  try{
    const result=await client.request(job,'/v2/search',{query:'site:shopee.co.th '+query},scope);
    const urls=new Map<string,string>();
    for(const hit of result.payload?.data?.web??[]){
      const id=shopeeProductId(hit.url);
      const url=id&&sourceKey(hit.url);
      if(id&&url&&url.length<=2048&&!urls.has(id))urls.set(id,url);
    }
    for(const url of [...urls.values()].slice(0,5)){
      try{
        const page=await client.request(job,'/v2/scrape',{url},scope);
        const item=readListing(url,page);
        if(!item){notes.add('ยืนยันรายละเอียดสินค้าบางหน้าจาก Shopee ไม่ได้');continue;}
        if(cap!==null&&(!item.price||Number(item.price.replace(/[^\d.]/g,''))>cap)){
          notes.add('คัดออกเมื่อราคายังยืนยันไม่ได้หรือเกินงบที่ระบุ');continue;
        }
        evidence.push(item);
      }catch(e){warn(e);if(!(e instanceof ResearchBudgetError)||e.code!=='no_evidence')break;}
    }
  }catch(e){warn(e);}
  if(!evidence.length)notes.add('ยังไม่มีหน้าสินค้าที่มีหลักฐานตรงกับคำค้น');
  if(evidence.some(p=>p.cached))notes.add('บางหน้าใช้หลักฐานที่บันทึกไว้ภายใน 24 ชั่วโมง');
  return {evidence,notice:[...notes].join(' · ')||null};
}

// Let the selected LLM choose the listings, review angles and hooks. Commercial facts are copied exclusively from verified fields.
const angles={
  closeup:{reason:'ใช้ภาพระยะใกล้ให้ผู้ชมดูรายละเอียดสินค้าก่อนเลือก',hook:(n:string)=>'ก่อนเลือก'+n+' มาดูใกล้ ๆ ด้วยกัน'},
  demonstration:{reason:'สาธิตวิธีใช้ให้เห็นในมือ เหมาะกับคลิปสั้น',hook:(n:string)=>n+' ใช้ยังไง มาลองให้ดู'},
  decision:{reason:'เล่าในมุมคนกำลังเลือกซื้อ แล้วพากล้องไปดูสินค้าจริง',hook:(n:string)=>'กำลังดู'+n+'อยู่ไหม มาดูของจริงกัน'},
  scale:{reason:'ถือเทียบกับมือ ให้ผู้ชมกะขนาดจากภาพได้',hook:(n:string)=>'พอถือ'+n+'ในมือ หน้าตาเป็นแบบนี้'},
};
// Generated copy is creative direction. Prices, promos, ranking and sales signals have their own sourced fields.
const salesClaim=/[0-9๐-๙%฿$]|ราคา|บาท|เปอร์เซ็นต์|ยอด(?:ขาย|สั่ง|นิยม)|ขายดี|มาแรง|ไวรัล|กำลังโต|เติบโต|เพิ่มขึ้น|อันดับ|ขายไป|ขายได้|เทรนด์|เทรนด|หมื่น|แสน|ล้าน|พันชิ้น|ลดราคา|ส่วนลด|คุ้มสุด|ถูกสุด|ถูกที่สุด|โปรโม|โปรโมชั่น|โปรแรง|ฟรี|แถม|คูปอง|รับประกัน|พร้อมส่ง|สต็อก|ดีที่สุด|เบอร์หนึ่ง|ฮิต|sold|best.?seller|discount|sale|trending|top.?rank/iu;
export const ideaInstructions='อ่านคำค้นและหลักฐานหน้าสินค้า Shopee ไทยที่ส่งให้เป็นข้อมูล เลือกไม่เกิน 5 รหัสที่ตอบคำค้น เรียงจากเหมาะกับการรีวิวที่สุด เลือกมุมและ Hook ของสินค้าแต่ละชิ้นจาก closeup (ซูมรายละเอียด), demonstration (สาธิต), decision (ช่วยเลือกซื้อ), scale (เทียบขนาดในมือ) เสนอ hook ภาษาไทยชวนดูหรือชวนลองด้วยคำถามหรือชวนดูสินค้าจริง (2–80 ตัวอักษร) และ reason เป็นคำแนะนำวิธีถ่ายเจาะจงกับสินค้า (2–160 ตัวอักษร) เขียนเฉพาะมุมสร้างสรรค์ ห้ามใส่คำกล่าวอ้างราคา ยอดขาย อันดับ โปร หรือการเติบโต ไม่สมมติคุณสมบัติสินค้า subject คือคำเรียกสินค้าสั้น ๆ ที่คัดตรงจากชื่อจริง ห้ามค้นเว็บหรือเติมข้อมูล ตอบ JSON {"picks":[{"id":"shop.item","angle":"closeup","subject":"...","hook":"...","reason":"..."}]}';
export function ideaCards(evidence:Listing[],prose:string){
  const picks=z.object({picks:z.array(z.object({id:z.string(),angle:z.enum(['closeup','demonstration','decision','scale']),subject:z.string().max(48).optional(),hook:z.string().max(180).optional(),reason:z.string().max(300).optional()})).max(5)}).parse(JSON.parse(prose)).picks;
  const seen=new Set<string>();
  return picks.flatMap(p=>{
    const item=evidence.find(e=>e.id===p.id);
    if(!item||seen.has(p.id))return [];
    seen.add(p.id);
    // Keep the handoff Hook inside Studio's existing 85-character contract.
    const subject=p.subject?.trim();
    const short=subject&&item.name.includes(subject)&&!salesClaim.test(subject)?subject:
      item.name.length<=48&&!salesClaim.test(item.name)?item.name:'สินค้าชิ้นนี้';
    const creative=(value:string|undefined,max:number)=>value&&value.length<=max&&/[ก-๙]/.test(value)&&
      !salesClaim.test(value)&&!/(?:https?:|www\.|ส่งวันนี้|สรรพคุณ|รักษา|การันตี|ขายหมด|หมดไว|ไร้คู่แข่ง)/i.test(value) ? value.trim():null;
    return [{...item,reason:creative(p.reason,160)||angles[p.angle].reason,hook:creative(p.hook,85)||angles[p.angle].hook(short)}];
  });
}
