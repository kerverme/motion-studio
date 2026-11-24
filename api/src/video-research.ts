import {createHash} from 'node:crypto';
import type pg from 'pg';
import {extractWebEvidence, sourceKey} from './source-evidence.js';
import {BudgetedFirecrawl, PgResearchBudget, RESEARCH_CREDIT_LIMIT} from './firecrawl-budget.js';

type Input = {topic:string; source_text?:string; note?:string; sources?:unknown; language?:string};
type Citation = {url:string; claim?:string; supporting_quote?:string; [key:string]:unknown};
type Proof = {url:string; claim:string; method:'openai_page'|'firecrawl_passage'; checked_at:string; supporting_quote?:string};
type Result = {sources:Citation[]; evidence:Proof[]};
function inputHash(input:Input) {
  return createHash('sha256').update(JSON.stringify([input.topic.trim(), input.source_text || '',input.note || '',input.sources || null,input.language || ''])).digest('hex');
}
export async function cachedDirectorResearch(pool:pg.Pool,input:Input):Promise<Result|null> {
  return (await pool.query("SELECT result FROM video_director_research WHERE input_hash=$1 AND verified_at>now()-interval '24 hours'",[inputHash(input)])).rows[0]?.result || null;
}
const clean = (s:string) => s.normalize('NFKC').replace(/\s+/g,' ').trim();
export async function verifyDirectorSources(pool:pg.Pool,planId:string,response:any,sources:Citation[],input:Input,options:{firecrawlKey?:string;fetch?:typeof fetch}={}):Promise<Result> {
  if(!sources.length) return {sources:[],evidence:[]};
  if(sources.length>12) throw new Error('แหล่งข้อมูลเกินจำนวนที่ระบบตรวจได้ต่อแผน');
  const cached=await cachedDirectorResearch(pool,input);
  const web=extractWebEvidence(response);
  const observed=new Set(web.sources.map(s=>sourceKey(s.url)));
  const completed=(response?.output || []).filter((r:any)=>r?.type==='web_search_call' && r.status==='completed');
  const opened=new Set(completed.filter((r:any)=>['open_page','find_in_page'].includes(r.action?.type))
    .map((r:any)=>sourceKey(r.action?.url)));
  const pasted = new Set((JSON.stringify([input.topic,input.source_text,input.note,input.sources]).match(/https?:\/\/[^\s"<>]+/gu)||[]).map(sourceKey));
  const store=new PgResearchBudget(pool,RESEARCH_CREDIT_LIMIT);
  const key=options.firecrawlKey ?? process.env.FIRECRAWL_API_KEY;
  const fc=new BudgetedFirecrawl(store,{apiKey:key || '',baseUrl:'https://api.firecrawl.dev',fetch:options.fetch});
  const evidence:Proof[]=[];
  for(const citation of sources) {
    const url=sourceKey(citation.url);
    const claim=clean(String(citation.claim || ''));
    if(!url || !claim) throw new Error('แหล่งข้อมูลต้องมี URL และข้อความที่ใช้อ้างอิง');
    const proofKey=createHash('sha256').update(JSON.stringify([url,claim])).digest('hex');
    const previous=cached?.evidence.find(s=>sourceKey(s.url)===url && s.claim===claim) || await store.webRead(planId,proofKey);
    if(previous) {evidence.push(previous);continue;}
    let proof:Proof;
    if(opened.has(url)) {
      proof={url,claim,method:'openai_page',checked_at:new Date().toISOString()};
    } else {
      if(!completed.length || (!observed.has(url) && !pasted.has(url))) throw new Error('ยังไม่มีหลักฐานจากเครื่องมือค้นเว็บสำหรับแหล่งข้อมูลที่อ้างถึง');
      if(!key) throw new Error('เปิดหน้าต้นฉบับไม่สำเร็จและยังไม่ได้ตั้งค่า Firecrawl');
      // A search result alone is insufficient. Require supporting text in the retrieved page.
      const quote=clean(String(citation.supporting_quote || claim));
      if(quote.length<12) throw new Error('ข้อความสนับสนุนสั้นเกินไปที่จะตรวจสอบกับต้นฉบับ');
      if((await store.snapshot(planId)).limit!==RESEARCH_CREDIT_LIMIT) throw new Error('ขอบเขตงบวิจัยวิดีโอต้องเป็น 25 เครดิตต่องาน');
      const read=await fc.request(planId,'/v2/scrape',{url},{webAttempted:true,reason:'OpenAI search located the source but has no confirmed page open.'});
      const page=clean(String(read.payload?.data?.markdown || ''));
      if(!page.includes(quote)) throw new Error('ไม่พบข้อความสนับสนุนที่ตรงกับต้นฉบับ จึงยังยืนยันคำกล่าวอ้างไม่ได้');
      proof={url,claim,method:'firecrawl_passage',checked_at:new Date(read.collected_at).toISOString(),supporting_quote:quote};
    }
    await store.saveWebRead(planId,proofKey,proof);
    evidence.push(proof);
  }
  const result={sources,evidence};
  // Preserve the original evidence timestamps on reads so cache hits cannot renew stale research.
  if(!cached || evidence.some(p=>!cached.evidence.some(prev=>prev.checked_at===p.checked_at && prev.url===p.url && prev.claim===p.claim))) {
    const oldest = new Date(Math.min(...evidence.map(p=>Date.parse(p.checked_at))));
    await pool.query('INSERT INTO video_director_research(input_hash,result,verified_at) VALUES ($1,$2,$3) ON CONFLICT(input_hash) DO UPDATE SET result=excluded.result,verified_at=excluded.verified_at',[inputHash(input),JSON.stringify(result),oldest]);
  }
  return result;
}
