import type {Queryable} from './store.js';
const rich=(text:unknown)=>({rich_text:String(text??'').match(/[\s\S]{1,1800}/g)?.slice(0,20).map(content=>({type:'text',text:{content}}))??[]});
const date=(value:any)=>({date:value?{start:new Date(value).toISOString()}:null});
export function notionProperties(r:any) {
  return {
    'Trend / Topic':{title:[{type:'text',text:{content:r.title.slice(0,300)}}]},
    'Platform':{select:{name:r.platform==='tiktok'?'TikTok':'Instagram'}},'Source URL':{url:r.source_url},'Source ID':rich(r.platform+':'+r.source_id),
    'Published At':date(r.published_at),'Discovered At':date(r.discovered_at),'Last Checked':date(r.last_checked),'Last Trend Evidence At':date(r.last_trend_evidence_at),
    'Views':{number:r.views==null?null:Number(r.views)},'Likes':{number:r.likes==null?null:Number(r.likes)},'Comments':{number:r.comments==null?null:Number(r.comments)},
    'Engagement Rate':{number:r.engagement_rate},'Trend Score':{number:Number(r.trend_score)},'Research Summary':rich(r.research_summary),
    'Evidence':rich(JSON.stringify({observation:r.evidence,score:r.score_details})), 'Suggested Angles':rich((r.suggested_angles||[]).join('\n')),
    'Status':{select:{name:r.status}},'Used in Studio':{checkbox:r.used_in_studio},'Created Topic':rich(r.created_topic),'Research Run ID':rich(r.research_run_id),
  };
}
// The worker holds a PostgreSQL advisory lock throughout synchronization. A timed-out
// create is reconciled by stable Source ID before any subsequent create is attempted.
export async function syncNotion(db:Queryable,row:any,request:typeof fetch=fetch) {
  const database=process.env.NOTION_TREND_DATABASE_ID,token=process.env.NOTION_TOKEN;
  if(!database||!token)throw new Error('Notion trend database is not configured');
  const call=async(path:string,body:any,method='POST')=>{
    const res=await request('https://api.notion.com/v1/'+path,{method,headers:{Authorization:'Bearer '+token,'Notion-Version':'2022-06-28','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    if(!res.ok)throw new Error('Notion HTTP '+res.status);return res.json() as Promise<any>;
  };
  try {
    let page=row.notion_page_id;
    if(!page){
      const found=await call(`databases/${database}/query`,{filter:{or:[{property:'Source ID',rich_text:{equals:row.platform+':'+row.source_id}},{property:'Source URL',url:{equals:row.source_url}}]},page_size:2});
      if(found.results.length>1)throw new Error('Notion duplicate source requires review');
      page=found.results[0]?.id;
      if(!page&&row.notion_sync_error==='create_uncertain')throw new Error('Notion create_uncertain; reconcile before retrying');
    }
    const properties=notionProperties(row);
    if(page)await call('pages/'+page,{properties},'PATCH');
    else {
      await db.query("UPDATE trend_sources SET notion_sync_error='create_uncertain' WHERE id=$1",[row.id]);
      page=(await call('pages',{parent:{database_id:database},properties})).id;
    }
    await db.query('UPDATE trend_sources SET notion_page_id=$2,notion_synced_at=now(),notion_sync_error=NULL WHERE id=$1',[row.id,page]);
    return page;
  }catch(error){
    // Preserve the ambiguous-create marker; never expose external response bodies.
    await db.query("UPDATE trend_sources SET notion_sync_error=CASE WHEN notion_sync_error='create_uncertain' THEN notion_sync_error ELSE $2 END WHERE id=$1",[row.id,error instanceof Error?error.message.slice(0,150):'Notion sync failed']);throw error;
  }
}
