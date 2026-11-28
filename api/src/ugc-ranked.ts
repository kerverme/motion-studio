import { ugcFalIndex, ugcFalSchemas, ugcKnownAlias, type UgcFalIdentity } from './video-registry.js';

export const arenaUrl='https://arena.ai/leaderboard/video/image-to-video';
export const featuredUrl='https://fal.ai/explore/new-and-noteworthy';
export type ArenaRow={key:string;rank:number;name:string;developer:string};
type Section=Record<string,any>;

// Both publications deliver a Next.js Flight stream. Only inspect complete JSON records
// and the overall Models table / named editorial section, never navigation or the overview.
function section(payload:string,match:(obj:Section)=>boolean):Section{
  const walk=(v:unknown):Section|undefined=>{
    if(!v||typeof v!=='object')return;
    if(!Array.isArray(v)&&match(v))return v;
    for(const child of Object.values(v)){const found=walk(child);if(found)return found;}
  };
  const chunks:string[]=[];
  for(const m of payload.matchAll(/self\.__next_f\.push\(\s*(\[1,\s*"(?:\\.|[^"\\])*"\s*\])\s*\)/g)){
    chunks.push(JSON.parse(m[1])[1]);
  }
  for(const line of chunks.join('').split('\n')){
    const start=/^[\da-f]+:([\[{])/i.exec(line);
    if(!start)continue;
    let value;try{value=JSON.parse(line.slice(line.indexOf(':')+1));}catch{continue;}
    const found=walk(value);if(found)return found;
  }
  throw Error('หน้าเว็บไม่มีรายการโมเดลที่ตรวจสอบได้');
}
async function pages<T>(source:string, request:typeof fetch, match:(obj:Section)=>boolean,
  rows:(s:Section)=>T[], id:(v:T)=>string):Promise<T[]>{
  const output:T[]=[], seen=new Set<string>(), visited=new Set<string>();
  let url=new URL(source), expected:number|undefined;
  for(let page=1;;page++){
    if(visited.has(url.href)||url.origin!==new URL(source).origin||url.pathname!==new URL(source).pathname)throw Error('ลิงก์แบ่งหน้าไม่ถูกต้อง');
    visited.add(url.href);
    const r=await request(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(18000)});
    if(!r.ok)throw Error('HTTP '+r.status);
    const s=section(await r.text(),match);
    const total=s.totalModels??s.total;
    if(total!==undefined&&(!Number.isSafeInteger(total)||total<0||(expected!==undefined&&total!==expected)))throw Error('จำนวนโมเดลเปลี่ยนระหว่างดึงหน้า');
    expected=total??expected;
    const list=rows(s);
    for(const item of list){const key=id(item);if(!key||seen.has(key))throw Error('พบข้อมูลแบ่งหน้าซ้ำ');seen.add(key);output.push(item);}
    const next=s.nextPage??s.next_page, cursor=s.nextCursor??s.next_cursor;
    if((expected===undefined||output.length===expected)&&!next&&!cursor&&!s.hasMore&&!s.has_more)return output;
    if(!list.length||(expected!==undefined&&output.length>expected))throw Error('ดึงรายชื่อได้ไม่ครบ');
    url=new URL(source);
    if(typeof next==='string'&&!/^\d+$/.test(next))url=new URL(next,url);
    else if(cursor)url.searchParams.set('cursor',String(cursor));
    else url.searchParams.set('page',String(next||page+1));
  }
}
export async function arenaModels(request=fetch):Promise<ArenaRow[]>{
  const rows=await pages<ArenaRow>(arenaUrl,request,s=>s.arenaSlug==='image-to-video'&&s.leaderboardSlug==='overall'&&Array.isArray(s.entries),
    s=>s.entries.map((e:any)=>{
      if(!Number.isSafeInteger(e.rank)||e.rank<1||![e.modelKey,e.modelOrganization,e.modelDisplayName].every(v=>typeof v==='string'&&v.trim()))throw Error('ข้อมูลอันดับไม่ครบ');
      return {rank:e.rank,key:e.modelKey,name:e.modelDisplayName,developer:e.modelOrganization} as ArenaRow;
    }),row=>row.key);
  if(!rows.length||rows.some((r,i)=>i>0&&rows[i-1].rank>r.rank))throw Error('ลำดับ Models จาก Arena ไม่สมบูรณ์');
  return rows;
}
export async function noteworthyModels(request=fetch):Promise<string[]>{
  const rows=await pages<{id:string;category:string}>(featuredUrl,request,s=>s.slug==='new-and-noteworthy'&&Array.isArray(s.models),
    s=>s.models.map((x:any)=>{
      if(typeof x.model?.endpoint!=='string'||!x.model.category)throw Error('ข้อมูลรายการแนะนำไม่ครบ');
      return {id:x.model.endpoint as string,category:x.model.category as string};
    }),r=>r.id);
  return rows.filter(x=>x.category==='image-to-video').map(x=>x.id);
}
export const rankSources={arena:arenaModels,featured:noteworthyModels,index:ugcFalIndex,schemas:ugcFalSchemas};
export type RankSources=typeof rankSources;

const normalized=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const route=(s:string)=>s+'/image-to-video';
const aliases:Record<string,string>={
  'minimax h3 max':'minimax/h3-max','minimax h3 max turbo':'minimax/h3-max-turbo',
  'wan 2 7':'fal-ai/wan/v2.7','wan 2 6':'wan/v2.6','wan 2 5 preview':'fal-ai/wan-25-preview','wan 2 2 a14b':'fal-ai/wan/v2.2-a14b',
  'veo 3 1':'fal-ai/veo3.1','veo 3 1 fast':'fal-ai/veo3.1/fast','veo 3':'fal-ai/veo3','veo 3 fast':'fal-ai/veo3/fast','veo 2':'fal-ai/veo2',
  'kling 3 0 pro':'fal-ai/kling-video/v3/pro','kling 2 6 pro':'fal-ai/kling-video/v2.6/pro',
  'kling 2 1 master':'fal-ai/kling-video/v2.1/master','kling 2 1 standard':'fal-ai/kling-video/v2.1/standard',
  'pixverse v5 6':'fal-ai/pixverse/v5.6','seedance 1 0 lite':'fal-ai/bytedance/seedance/v1/lite','seedance 1 0 pro':'fal-ai/bytedance/seedance/v1/pro',
  'hailuo 02 pro':'fal-ai/minimax/hailuo-02/pro','hailuo 02 standard':'fal-ai/minimax/hailuo-02/standard','hailuo 02 fast':'fal-ai/minimax/hailuo-02-fast',
};
function developerOf(m:UgcFalIdentity){
  if(m.developer)return normalized(m.developer);
  const part=m.id.replace(/^fal-ai\//,'').split('/')[0];
  if(/^(veo|google)/.test(part))return 'google';
  if(/^(kling|kwaivgi)/.test(part))return 'klingai';
  if(/^(wan|alibaba)/.test(part))return 'alibaba';
  if(part==='vidu')return 'shengshu';
  if(part==='xai')return 'spacexai';
  if(part==='blackforestlabs')return 'black forest labs';
  if(part==='luma-dream-machine')return 'luma ai';
  return normalized(part);
}
function developerKey(name:string){return normalized(name).replace(/^(?:xai|x ai|spacexai)$/,'spacexai').replace(/^kling ai$/,'klingai');}
export function matchRank(row:ArenaRow,index:UgcFalIdentity[]){
  const spec=row.name.match(/\s*\((?:(audio)(?:,\s*)?)?(\d+p)?\)\s*$/i);
  const label=spec?row.name.slice(0,spec.index):row.name;
  const name=normalized(label);
  const fullAliases:Record<string,string>={
    'vidu q2 pro':'fal-ai/vidu/q2/image-to-video/pro','vidu q2 turbo':'fal-ai/vidu/q2/image-to-video/turbo',
  };
  const expected=ugcKnownAlias(label)||fullAliases[name]||(aliases[name]?route(aliases[name]):undefined);
  const owner=index.filter(m=>developerKey(developerOf(m))===developerKey(row.developer));
  const exact=(m:UgcFalIdentity)=>{
    if(expected)return m.id===expected||['text-to-video','reference-to-video','video-to-video'].some(mode=>
      m.id===expected.replace('/image-to-video','/'+mode));
    const display=normalized(m.name.replace(/\b(?:image|text)[ -]to[ -]video\b/ig,''));
    const path=m.id.replace(/^fal-ai\//,'').replace(/\/(?:image|text)-to-video(?:\/|$)/,'/');
    const identifiers=[path,path.split('/').slice(1).join('/')].map(normalized);
    return identifiers.includes(name)&&display===name;
  };
  const matches=owner.filter(exact);
  const candidates=matches.filter(m=>m.category==='image-to-video'&&(!expected||m.id===expected)&&!/(?:^|\/)(?:reference|video)-to-video(?:\/|$)/.test(m.id));
  const family=name.split(' ').find(t=>!['dreamina','minimax'].includes(t))||name;
  const related=owner.find(m=>normalized(m.name+' '+m.id).split(' ').includes(family));
  const id=candidates.length===1?candidates[0].id:undefined;
  const reason=id?(!candidates[0].active?'endpoint ยังไม่เปิดใช้งาน':undefined):
    candidates.length>1?'พบหลาย variant ที่ยังแยกไม่ได้':matches.length?'endpoint รุ่นนี้ไม่รับภาพเปิด':
    related?'ยังไม่มีบน fal.ai · พบตระกูลเดียวกันแต่รุ่นหรือ variant ไม่ตรง':'ยังไม่มีบน fal.ai';
  return {id,reason,resolution:spec?.[2]?.toLowerCase()};
}
