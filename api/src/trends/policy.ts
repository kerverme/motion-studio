export type Platform = 'tiktok' | 'instagram';
export type Evidence = {
  platform:Platform; sourceId:string; url:string; title:string;
  publishedAt:string|null; observedAt:string; views:number|null; likes:number|null; comments:number|null;
  detailRead:boolean; available:boolean; publicationEvidence:string|null;
};
export const WINDOW_MS=7*86400_000;
export const DEFAULT_WEIGHTS={popularity:.35,freshness:.25,suitability:.25,novelty:.15};
export function canonicalSource(raw:string):{platform:Platform;sourceId:string;url:string}|null {
  try {
    const u=new URL(raw); if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
    let m;
    if(['www.tiktok.com','tiktok.com','m.tiktok.com'].includes(u.hostname)&&(m=u.pathname.match(/^\/@([\w.-]+)\/video\/(\d+)\/?$/)))
      return {platform:'tiktok',sourceId:m[2],url:`https://www.tiktok.com/@${m[1]}/video/${m[2]}`};
    if(['www.instagram.com','instagram.com'].includes(u.hostname)&&(m=u.pathname.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/)))
      return {platform:'instagram',sourceId:m[1],url:`https://www.instagram.com/p/${m[1]}/`};
    return null;
  } catch{return null;}
}
export function metric(v:unknown):number|null {
  // No parsing rounded labels ("1.2M") or treating unavailable values as zero.
  if(typeof v==='string'&&/^\d+$/.test(v))v=Number(v);
  return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
}
export function sourceDate(v:unknown):string|null {
  if(typeof v==='number'&&v>1e9&&v<1e13){const d=new Date(v<1e11?v*1000:v);return Number.isFinite(+d)?d.toISOString():null;}
  if(typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)&&Number.isFinite(Date.parse(v)))return new Date(v).toISOString();
  return null;
}
export function scoreEvidence(e:Evidence,previous:Evidence[], options:{now?:number;weights?:typeof DEFAULT_WEIGHTS;minimum?:number;suitability?:number;suitabilityReason?:string;used?:boolean;minimumViews?:number;minimumLikes?:number}={}) {
  const now=options.now??Date.now(), cutoff=now-WINDOW_MS, published=e.publishedAt?Date.parse(e.publishedAt):NaN, checked=Date.parse(e.observedAt);
  const weights=options.weights??DEFAULT_WEIGHTS;
  if(Object.values(weights).some(x=>!Number.isFinite(x)||x<0)||Math.abs(Object.values(weights).reduce((a,b)=>a+b,0)-1)>.0001)throw new Error('Trend weights must be nonnegative and sum to one');
  const recent=published>=cutoff&&published<=now&&!!e.publicationEvidence;
  const before=previous.filter(x=>x.detailRead&&x.available&&Date.parse(x.observedAt)>=cutoff&&checked-Date.parse(x.observedAt)>=6*3600_000).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt))[0];
  const viewGrowth=before?.views!=null&&e.views!=null?e.views-before.views:null;
  const likeGrowth=before?.likes!=null&&e.likes!=null?e.likes-before.likes:null;
  const growth=!!before&&((viewGrowth!==null&&viewGrowth>=1000&&viewGrowth/Math.max(1,before.views!)>=.1)||(likeGrowth!==null&&likeGrowth>=100&&likeGrowth/Math.max(1,before.likes!)>=.1));
  const popular=(e.views!=null&&e.views>=(options.minimumViews??10000))||(e.likes!=null&&e.likes>=(options.minimumLikes??1000));
  const evidenceAt=growth?e.observedAt:recent?e.publishedAt:null;
  const popularity=Math.min(100,Math.max(e.views==null?0:Math.log10(Math.max(1,e.views))*16,e.likes==null?0:Math.log10(Math.max(1,e.likes))*22,growth?80:0));
  const freshness=evidenceAt?Math.max(0,100-(now-Date.parse(evidenceAt))/WINDOW_MS*100):0;
  const suitability=Math.min(100,Math.max(0,options.suitability??0)),novelty=options.used?0:100;
  const components={popularity,freshness,suitability,novelty};
  const score=Math.round(Object.entries(components).reduce((n,[k,v])=>n+v*weights[k as keyof typeof weights],0)*10)/10;
  const eligible=e.available&&e.detailRead&&checked<=now&&checked>=cutoff&&((recent&&popular)||growth)&&score>=(options.minimum??70);
  const status=!e.available?'Failed':eligible?'Active':Number.isFinite(published)&&published<cutoff&&!growth?'Expired':'Unverified';
  const reasons=[recent?'Published in the rolling seven-day window':'No verified recent publication',growth?`Observed growth: views ${viewGrowth??'unknown'}, likes ${likeGrowth??'unknown'}`:'Recent growth unknown; never inferred from total views',e.detailRead?'Source detail read':'Source detail not read',options.suitabilityReason??'AI suitability not assessed'];
  return {status,score,evidenceAt,components,weights,reasons,viewGrowth,likeGrowth,engagementRate:e.views&&e.likes!=null&&e.comments!=null?(e.likes+e.comments)/e.views:null};
}
export function isEligible(row:any,now=Date.now()) {
  return row.status==='Active'&&Number(row.trend_score)>=(Number(process.env.TREND_MIN_SCORE)||70)&&!!row.notion_page_id&&!!row.notion_synced_at&&new Date(row.last_trend_evidence_at).getTime()>=now-WINDOW_MS&&new Date(row.last_checked).getTime()>=now-WINDOW_MS;
}
export const bangkokDate=(v:string)=>new Intl.DateTimeFormat('th-TH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Bangkok'}).format(new Date(v));
