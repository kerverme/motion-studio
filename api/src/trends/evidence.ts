import {GROWTH_INTERVAL_MS} from './observations.js';
import {canonicalSource,metric,sourceDate,WINDOW_MS,type Evidence,type Platform} from './policy.js';
export type SocialEvidence=Evidence&{author:string|null;provider:string;capability:string;content:string;metric_origin:'provider_reported';warnings:string[]; reused_media?:string; repost?:boolean};
const text=(v:any)=>typeof v==='string'?v:'';
const timestamp=(v:any)=>sourceDate(typeof v==='string'&&/^\d{10,13}$/.test(v)?Number(v):v);
/** Explicit vendor response mappings; unknown fields never become invented dates or metrics. */
export function normaliseSocial(capability:string,data:any,collectedAt:string):SocialEvidence[]{
 if(data?.success===false)return [];
 const platform=capability.split('/')[0] as Platform;
 const providerCachedAt=data?.cached===true?timestamp(data.cached_at):null;
 const observedAt=providerCachedAt||collectedAt;
 let list:any[]=[];
 if(capability==='tiktok/search-videos')list=(data?.search_item_list||[]).map((r:any)=>r.aweme_info||r);
 if(capability==='tiktok/video')list=[data?.aweme_detail||data?.aweme_info||data?.data?.aweme_detail||data];
 if(capability==='instagram/search-reels')list=data?.reels||[];
 if(capability==='instagram/post')list=[data?.data?.xdt_shortcode_media||data?.data?.shortcode_media||data?.data||data];
 if(capability==='youtube/search')list=[...(data?.videos||[]),...(data?.shorts||[])];
 if(capability==='youtube/video')list=[data];
 const result:SocialEvidence[]=[];
 for(const raw of Array.isArray(list)?list:[]){
  if (!raw) continue;
  let url='',content='',author:string|null=null,publishedAt:string|null=null,views:number|null=null,likes:number|null=null,comments:number|null=null;
  if(platform==='tiktok'){
   author=text(raw.author?.unique_id)||text(raw.author?.uniqueId)||null;
   url=text(raw.url)||text(raw.share_url)||(author&&/^\d+$/.test(String(raw.aweme_id))?`https://www.tiktok.com/@${author}/video/${raw.aweme_id}`:'');
   content=text(raw.desc);publishedAt=timestamp(raw.create_time)||timestamp(raw.create_time_utc);
   views=metric(raw.statistics?.play_count);likes=metric(raw.statistics?.digg_count);comments=metric(raw.statistics?.comment_count);
  }else if(platform==='instagram'){
   const shortcode=text(raw.shortcode)||text(raw.code);
   url=text(raw.url)||(shortcode?'https://www.instagram.com/p/'+shortcode+'/':'');author=text(raw.owner?.username)||text(raw.user?.username)||null;
   content=text(raw.caption)||text(raw.caption?.text)||text(raw.edge_media_to_caption?.edges?.[0]?.node?.text);
   publishedAt=timestamp(raw.taken_at_timestamp)||timestamp(raw.taken_at);
   views=metric(raw.video_play_count??raw.play_count??raw.video_view_count);likes=metric(raw.like_count??raw.edge_media_preview_like?.count);comments=metric(raw.comment_count??raw.edge_media_to_parent_comment?.count??raw.edge_media_to_comment?.count);
  }else if(platform==='youtube'){
   url=text(raw.url)||text(raw.videoUrl);author=text(raw.channel?.id)||text(raw.channel?.handle)||text(raw.channel?.name)||null;
   content=[text(raw.title),text(raw.description)].filter(Boolean).join('\n');publishedAt=timestamp(raw.publishedAt)||timestamp(raw.publishDate)||timestamp(raw.publishedTime);
   views=metric(raw.viewCount??raw.views);likes=metric(raw.likeCount??raw.likes);comments=metric(raw.commentCount);
  }
  const identity=canonicalSource(url);if(!identity||identity.platform!==platform)continue;
  const expectedId=platform==='tiktok'?raw.aweme_id:platform==='instagram'?(raw.shortcode||raw.code):(raw.id||raw.videoId);
  if(expectedId!=null&&String(expectedId)!==identity.sourceId)continue;
  const detailRead=Boolean(content.trim()&&publishedAt&&(data?.cached!==true||providerCachedAt));
  result.push({...identity,sourceId:identity.sourceId,title:content.trim().slice(0,300)||identity.url,content:content.slice(0,12000),author,publishedAt,observedAt,views,likes,comments,detailRead,available:true,publicationEvidence:publishedAt,provider:'scrapecreators',capability,metric_origin:'provider_reported',repost:raw.is_repost===true||raw.isRepost===true||Boolean(raw.repost_of?.id),reused_media:platform==='tiktok'?text(raw.video?.vid)||undefined:undefined,warnings:platform==='instagram'?['ยอดเล่นจากผู้ให้บริการอาจคลาดเคลื่อนและไม่รวม Facebook']:[]});
 }
 return [...new Map(result.map(e=>[e.url,e])).values()];
}
export function recentEvidence(e:Evidence,now=Date.now()){
 const p=Date.parse(e.publishedAt||''),o=Date.parse(e.observedAt);
 return e.available&&e.detailRead&&p>=now-WINDOW_MS&&p<=now&&o>=now-WINDOW_MS&&o<=now;
}
const creatorKey = (e:SocialEvidence) => e.author?.normalize('NFKC').trim().replace(/^@/,'').toLowerCase()||'';
export const postKey = (e:SocialEvidence) => e.platform+':'+e.sourceId;

export function independentPosts(posts:SocialEvidence[]) {
 const identities=new Set<string>(), media=new Set<string>(), captions=new Set<string>();
 return [...posts].sort((a,b)=>Date.parse(a.publishedAt||'')-Date.parse(b.publishedAt||'')).filter(post=>{
  const id=postKey(post), mediaId=post.reused_media?post.platform+':'+post.reused_media:null;
  const caption=post.content.normalize('NFKC').toLowerCase()
   .replace(/https?:\/\/\S+|[@#][\p{L}\p{M}\p{N}_]+/gu,'').replace(/[^\p{L}\p{M}\p{N}]/gu,'');
  const longCaption=caption.length>=40?caption:null;
  if(post.repost||identities.has(id)||(mediaId&&media.has(mediaId))||(longCaption&&captions.has(longCaption)))return false;
  identities.add(id);
  if(mediaId)media.add(mediaId);
  if(longCaption)captions.add(longCaption);
  return true;
 });
}
export const hasAudienceSignal = (e:SocialEvidence) => (e.views??0)>=1000 || (e.likes??0)>=50 || (e.comments??0)>=10;

export type Assessment={title:string;category:string;summary:string;reason:string;relevance:number;novelty:number;source_ids:string[];quotes:{source_id:string;quote:string}[];angles:string[]};
export function assessPattern(a:Assessment,all:SocialEvidence[],previous:SocialEvidence[]=[],now=Date.now()){
 const ids=new Set(a.source_ids),sources=all.filter(e=>ids.has(postKey(e))&&recentEvidence(e,now));
 const quoted=sources.filter(e=>a.quotes.some(q=>q.source_id===postKey(e)&&q.quote.trim().length>=8&&e.content.includes(q.quote.trim())));
 const matched=independentPosts(quoted);
 const authors=new Set(matched.map(creatorKey).filter(Boolean));
 const corroborated=matched.length>=2&&authors.size>=2&&new Set(quoted.map(postKey)).size===ids.size;
 const platforms=[...new Set(matched.map(e=>e.platform))];
 const recency=matched.length?Math.max(...matched.map(e=>100-(now-Date.parse(e.publishedAt!))/WINDOW_MS*100)):0;
 const observedMetrics=matched.flatMap(e=>[e.views,e.likes,e.comments]).filter(v=>v!=null).length;
 const engagement=observedMetrics?Math.min(100,Math.max(...matched.map(e=>Math.max(
  e.views==null?0:Math.log10(Math.max(1,e.views))*16,
  e.likes==null?0:Math.log10(Math.max(1,e.likes))*22,
  e.comments==null?0:Math.log10(Math.max(1,e.comments))*25
 )))):null;
 const growth=matched.flatMap(e=>{
  const observed=Date.parse(e.observedAt);
  const before=previous.filter(p=>postKey(p)===postKey(e)&&p.available&&p.detailRead&&
   Date.parse(p.observedAt)<=observed-GROWTH_INTERVAL_MS&&Date.parse(p.observedAt)>=Math.max(now-WINDOW_MS,Date.parse(e.publishedAt!))&&p.views!=null)
    .sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
  if(!before||e.views==null||before.views==null)return [];
  const delta=e.views-before.views;
  const hours=(observed-Date.parse(before.observedAt))/3600000;
  // Require a substantial change, from two separately observed points on the same post.
  if(delta<1000||delta/Math.max(1,before.views)<.1)return [];
  return [{url:e.url,platform:e.platform,author:creatorKey(e),from:before.observedAt,to:e.observedAt,
   views_before:before.views,views_after:e.views,views_delta:delta,views_per_hour:delta/hours}];
 });
 const growing=new Set(growth.map(g=>g.author).filter(Boolean)).size>=2;
 const components={recency:Math.max(0,recency),engagement,audience_relevance:a.relevance,topic_novelty:a.novelty,
  evidence_quality:corroborated?100:matched.length?35:0,
  growth_velocity:growth.length?Math.min(100,Math.log10(1+Math.max(...growth.map(g=>g.views_per_hour)))*25):null};
 // Score the observed interest itself. Platform coverage and growth are disclosed separately.
 const weights={recency:.2,engagement:.25,audience_relevance:.2,topic_novelty:.1,evidence_quality:.25};
 const score=Math.round(Object.entries(weights).reduce((sum,[key,weight])=>sum+(components[key as keyof typeof weights]??0)*weight,0)*10)/10;
 const completeness=matched.length?observedMetrics/(matched.length*3):0;
 const confidence=Math.round((corroborated?60:20)+20*completeness+(platforms.length>1?10:0)+(growing?10:0));
 const audienceEnough=new Set(matched.filter(hasAudienceSignal).map(creatorKey).filter(Boolean)).size>=2;
 const missing=[...(!growing?['ยังไม่มีหลักฐานว่ายอดวิวเพิ่มขึ้นจากครีเอเตอร์อย่างน้อยสองราย']:[]),
  ...(completeness<1?['สถิติบางรายการไม่มีข้อมูล']:[]),
  ...(!corroborated?['ยังไม่มีโพสต์ที่สอดคล้องกันจากครีเอเตอร์อย่างน้อยสองราย']:[]),
  ...(!audienceEnough?['ยังมีหลักฐานความสนใจจากผู้ชมไม่พอ']:[])];
 const verified=corroborated&&audienceEnough&&score>=(Number(process.env.TREND_MIN_SCORE)||70);
 const signal=verified?(growing?'growing':'interest'):'insufficient';
 return {verified,signal,platforms,creators_count:authors.size,score,confidence,sources:matched,components,weights,growth,missing,
  reason:a.reason,interpretation:a.summary,scope:'รูปแบบที่พบในชุดข้อมูล ไม่ใช่อันดับเทรนด์ทั้งประเทศหรือข้อยืนยันว่าไวรัล'};
}
