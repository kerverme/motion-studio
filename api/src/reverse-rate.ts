import {sha} from './reverse-contract.js';

// A price-page read is free and happens only when someone requests a quote after its
// configured snapshot expires. A changed published price still requires a Railway update.
export function configuredRate(raw:string|undefined){
  try{return JSON.parse(raw||'null');}catch{return null;}
}

export async function currentReverseRate(db:any,raw:string|undefined,workerRate:any,model:string,read:typeof fetch=fetch,now=Date.now()){
  const configured=configuredRate(raw);
  if(!configured||configured.model!==model||configured.currency!=='USD'||!workerRate||sha(configured)!==sha(workerRate))
    throw Error('ราคาและโมเดลบน API กับ worker ยังไม่ตรงกัน ตรวจ Railway');
  const expires=Date.parse(configured.valid_until);
  if(!Number.isFinite(expires)||!Number.isFinite(Date.parse(configured.checked_at)))throw Error('ไม่พบวันที่ยืนยันราคา OpenAI');
  if(expires>now)return configured;
  const source='https://developers.openai.com/api/docs/models/'+model;
  if(!['gpt-6.2-sol','gpt-transcribe'].includes(model)||configured.source!==source)throw Error('ต้องอัปเดตแหล่งราคาโมเดลบน Railway');
  const key='reverse_verified_price:'+model;
  const cached=(await db.query('SELECT data FROM integrations WHERE provider=$1',[key])).rows[0]?.data;
  if(cached&&sha(cached.configured)===sha(configured)&&Date.parse(cached.rate?.valid_until)>now)return cached.rate;
  const res=await read(source+'.md',{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw Error('ตรวจราคาล่าสุดจาก OpenAI ไม่สำเร็จ ลองดูราคาอีกครั้ง');
  const markdown=await res.text();
  const fields=model==='gpt-transcribe'?[['Price','minute','per_minute']]:
    [['Input','1M tokens','input_per_million'],['Cache writes','1M tokens','cache_write_per_million'],['Output','1M tokens','output_per_million']];
  // Parse the appropriate pricing *section* so another tier or modality cannot satisfy this check.
  const section=markdown.split('### '+(model==='gpt-transcribe'?'Transcription audio duration':'Text tokens'))[1]?.split(/\n##/)[0]||'';
  if(model==='gpt-6.2-sol'&&(!section.includes('30 minutes of retention')||!section.includes('272K input tokens, input and cache rates double and output costs 1.5 times')))
    throw Error('ยืนยันเงื่อนไขราคา OpenAI สำหรับบริบทยาวและการแคชไม่ได้');
  const parsed=section.split('\n').map(line=>line.split('|').map(cell=>cell.trim()));
  for(const [label,unit,field] of fields){
    const row=parsed.find(cells=>cells[1]===label&&cells[3]===unit);
    if(!row||!/^\$\d+(?:\.\d+)?$/.test(row[2])||Number(row[2].slice(1))!==configured[field])
      throw Error('ราคา OpenAI เปลี่ยนหรือยืนยันไม่ได้ กรุณาตรวจอัตราบน Railway');
  }
  const day=Math.floor(now/86400000)*86400000;
  const rate={...configured,checked_at:new Date(day).toISOString(),valid_until:new Date(day+7*86400000).toISOString()};
  await db.query('INSERT INTO integrations(provider,data,updated_at) VALUES($1,$2,now()) ON CONFLICT(provider) DO UPDATE SET data=EXCLUDED.data,updated_at=now()',
    [key,JSON.stringify({configured,rate})]);
  return rate;
}
