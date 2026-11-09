import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
process.env.MOTION_UI_PASSWORD='test-password';process.env.NOTION_TOKEN='mock-notion';process.env.BUFFER_API_KEY='mock-buffer';
const {registerUi}=await import('./ui.js');
const notion=await import('./notion.js');
const {reconcile}=await import('./metrics.js');
const db=new PGlite();const nativeFetch=globalThis.fetch;
const writes:{path:string,body:any}[]=[];let failNotion=false;let pageHook:(()=>Promise<void>)|null=null;let bufferPosts:any[]=[];
let schema:any={Status:{type:'select',select:{options:[{id:'ready',name:'Ready to post',color:'green'},{id:'posted',name:'Posted',color:'blue'}]}}};
const pool:any={query:(sql:string,args:any[]=[])=>db.query(sql,args),connect:async()=>({query:(sql:string,args:any[]=[])=>db.query(sql,args),release(){}})};
const app=new Hono();registerUi(app,pool,{API_TOKEN:'test-owner',retryJob:async()=>({ok:true})});
const headers={'authorization':'Bearer test-owner','content-type':'application/json'};
const req=(id:string,body:any={confirm:true})=>app.request('/app/api/episodes/'+id,{method:'DELETE',headers,body:JSON.stringify(body)});
let seq=20;
async function episode(status='ready',pending=false){
 const id=`10000000-0000-0000-0000-${String(seq++).padStart(12,'0')}`;
 await db.query('INSERT INTO episodes(id,number,topic,title_th,ui_status,notion_page_id) VALUES ($1,$2,$3,$3,$4,$5)',[id,seq,'ทดสอบลบคลิป',status,'page-'+id]);
 await db.query('INSERT INTO publication_handoffs(episode_id,folder_id,files) VALUES($1,$2,$3)',[id,'folder',JSON.stringify([{name:'clip.mp4',url:'https://media.cloudbath.co/'+id+'.mp4'}])]);
 if(pending)await db.query("INSERT INTO publish_log(episode_id,channel_id,mode,status) VALUES($1,'channel','addToQueue','pending')",[id]);
 return id;
}
before(async()=>{
 const dir=new URL('../migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(f,dir),'utf8'));
 await db.exec(readFileSync(new URL('017_deleted_episodes.sql',dir),'utf8'));
 globalThis.fetch=async(url:any,init:any)=>{
  const path=new URL(String(url)).pathname;const body=init?.body?JSON.parse(init.body):null;
  if(String(url).startsWith('https://api.buffer.com')){
   const query=String(body?.query||'');
   if(query.includes('organizations'))return Response.json({data:{account:{organizations:[{id:'org',name:'Test'}]}}});
   if(query.includes('channels'))return Response.json({data:{channels:[{id:'channel',name:'channel',service:'instagram'}]}});
   return Response.json({data:{posts:{edges:bufferPosts.map(node=>({node})),pageInfo:{hasNextPage:false}}}});
  }
  if(init.method==='GET'&&path.includes('/databases/'))return Response.json({properties:schema});
  if(init.method==='PATCH'&&path.includes('/databases/')){
   writes.push({path,body});
   for(const [key,value] of Object.entries(body.properties) as any[])schema[key]={...value,type:key==='Deleted'?'checkbox':'select'};
   return Response.json({properties:schema});
  }
  if(init.method==='PATCH'&&path.includes('/pages/')){
   if(pageHook){const hook=pageHook;pageHook=null;await hook();}
   if(failNotion)return Response.json({code:'validation_error',message:'test failure'},{status:400});
   writes.push({path,body});return Response.json({id:path.split('/').pop()});
  }
  throw new Error('Unexpected external call '+init.method+' '+path);
 };
});
after(async()=>{globalThis.fetch=nativeFetch;await db.close()});

test('deletion needs authentication and explicit confirmation, and refuses used or pending clips',async()=>{
 const id=await episode();assert.equal((await app.request('/app/api/episodes/'+id,{method:'DELETE'})).status,401);
 assert.equal((await req(id,{})).status,422);
 assert.equal((await req('bad-id')).status,400);
 assert.equal((await req('10000000-0000-0000-0000-000000000999')).status,404);
 assert.equal((await req(await episode('used'))).status,409);
 assert.equal((await req(await episode('ready',true))).status,409);
 assert.equal((await db.query<{ui_status:string}>('SELECT ui_status FROM episodes WHERE id=$1',[id])).rows[0].ui_status,'ready');
});

test('deletion hides a ready clip, checks Deleted and writes deleted on the same unarchived Notion page',async()=>{
 const id=await episode();const r=await req(id);assert.equal(r.status,200);const result=await r.json();assert.equal(result.notion.ok,true);
 const e:any=(await db.query('SELECT * FROM episodes WHERE id=$1',[id])).rows[0];assert.equal(e.ui_status,'deleted');assert.ok(e.deleted_at);assert.ok(e.notion_synced_at);assert.equal(e.notion_page_id,'page-'+id);
 const patch=writes.find(x=>x.path==='/v1/pages/page-'+id)!;assert.deepEqual(patch.body.properties.Status,{select:{name:'deleted'}});assert.deepEqual(patch.body.properties.Deleted,{checkbox:true});assert.equal('archived' in patch.body,false);assert.equal('in_trash' in patch.body,false);
 const schemaPatch=writes.find(x=>x.path.includes('/databases/'))!;assert.deepEqual(schemaPatch.body.properties.Status.select.options.map((x:any)=>x.name),['Ready to post','Posted','deleted']);assert.deepEqual(schemaPatch.body.properties.Deleted,{checkbox:{}});
 for(const tab of ['ready','used']){const list=await (await app.request('/app/api/episodes?tab='+tab,{headers})).json();assert.ok(!list.episodes.some((x:any)=>x.id===id));}
 assert.equal((await app.request('/app/api/episodes/'+id+'/used',{method:'POST',headers,body:JSON.stringify({used:false})})).status,404);
 assert.equal((await app.request('/app/api/episodes/'+id+'/publish',{method:'POST',headers,body:JSON.stringify({confirm:true,mode:'addToQueue',posts:[{channelId:'channel',text:'caption'}]})})).status,409);
 const again=await (await req(id)).json();assert.equal(again.notion.page_id,e.notion_page_id);
 const retained=(await db.query<{n:number}>('SELECT count(*)::int AS n FROM publication_handoffs WHERE episode_id=$1',[id])).rows[0].n;assert.equal(retained,1,'media handoff and history remain intact');
});

test('Notion failure keeps the deletion durable and visible for retry rather than reporting a false sync',async()=>{
 const id=await episode();failNotion=true;const r=await (await req(id)).json();failNotion=false;
 assert.equal(r.ok,true);assert.equal(r.notion.ok,false);
 const e:any=(await db.query('SELECT * FROM episodes WHERE id=$1',[id])).rows[0];assert.equal(e.ui_status,'deleted');assert.equal(e.notion_synced_at,null);assert.match(e.notion_error,/Notion 400/);
 assert.equal((await notion.syncEpisode(pool,id)).ok,true);
 assert.equal((await db.query<{notion_error:string|null}>('SELECT notion_error FROM episodes WHERE id=$1',[id])).rows[0].notion_error,null);
});

test('a stale ready sync cannot acknowledge a deletion that happened while Notion was updating',async()=>{
 const id=await episode();pageHook=async()=>{await db.query("UPDATE episodes SET ui_status='deleted',deleted_at=now(),notion_synced_at=NULL WHERE id=$1",[id])};
 await notion.syncEpisode(pool,id);
 const e:any=(await db.query('SELECT * FROM episodes WHERE id=$1',[id])).rows[0];assert.equal(e.notion_synced_at,null);
 await notion.syncEpisode(pool,id);assert.equal(writes.filter(x=>x.path==='/v1/pages/page-'+id).at(-1)!.body.properties.Deleted.checkbox,true);
});

test('publication reservation SQL rechecks deletion and does not create a pending post',async()=>{
 const id=await episode();await req(id);
 const sql=readFileSync(new URL('./ui.ts',import.meta.url),'utf8').match(/`INSERT INTO publish_log \(episode_id, channel_id, channel_name, service, mode, due_at, caption, status\)[\s\S]*?RETURNING id`/)![0].slice(1,-1);
 const ins=await db.query(sql,[id,'channel','Channel','instagram','addToQueue',null,'caption']);assert.equal(ins.rows.length,0);
 const ready=await episode();assert.equal((await db.query(sql,[ready,'channel','Channel','instagram','addToQueue',null,'caption'])).rows.length,1);
 assert.equal((await req(ready)).status,409,'reserved publication blocks deletion');
});


test('Buffer reconciliation retains the deleted state and Notion deletion takes precedence over post status',async()=>{
 const id=await episode();await req(id);
 bufferPosts=[{id:'external-post',status:'sent',channelId:'channel',createdAt:new Date().toISOString(),assets:[{source:'https://media.cloudbath.co/'+id+'.mp4'}]}];
 const changed=await reconcile(pool,id);assert.deepEqual(changed,[id]);
 assert.equal((await db.query<{ui_status:string}>('SELECT ui_status FROM episodes WHERE id=$1',[id])).rows[0].ui_status,'deleted');
 await notion.syncEpisode(pool,id);
 const properties=writes.filter(x=>x.path==='/v1/pages/page-'+id).at(-1)!.body.properties;assert.equal(properties.Status.select.name,'deleted');assert.equal(properties.Deleted.checkbox,true);
});
