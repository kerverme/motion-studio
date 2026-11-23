import pg from 'pg';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {Alexandria,verifyResearchModel} from './alexandria.js';
import {randomUUID} from 'node:crypto';
import {processResearchQueue} from './run-job.js';
import {syncNotion} from './notion.js';
import {reconcileUsage} from './provider.js';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const log=(event:string,data:any={})=>console.log(JSON.stringify({event,at:new Date().toISOString(),...data}));
let ready=false,busy=false;const workerId=randomUUID();let health:any={adapter:'firecrawl-alexandria',stage:'ready',busy:false};
createServer((req,res)=>{res.writeHead(req.url==='/health'?(ready?200:503):404,{'Content-Type':'application/json'}).end(JSON.stringify({ok:ready,...health}));}).listen(Number(process.env.PORT)||8080,'0.0.0.0');
async function start(){
 const db=await pool.connect();
 try{await db.query('SELECT pg_advisory_lock(424242)');
  const done=new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r=>r.name));
  for(const file of (await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())if(!done.has(file)){
   await db.query('BEGIN');await db.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);await db.query('COMMIT');log('migration_applied',{file});
  }
 }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.query('SELECT pg_advisory_unlock(424242)');db.release();}
 const adapter=new Alexandria({apiKey:process.env.FIRECRAWL_API_KEY||''});
 try{health.firecrawl=await adapter.credits();log('firecrawl_credit_balance',health.firecrawl);}catch{health.firecrawl={error:'credit_check_unavailable'};}
 const model=await verifyResearchModel(process.env.TREND_RESEARCH_MODEL||'');health.model=model;
 log('research_model_verified',model);
 try{const notion=await fetch('https://api.notion.com/v1/databases/'+process.env.NOTION_TREND_DATABASE_ID,{headers:{Authorization:'Bearer '+process.env.NOTION_TOKEN,'Notion-Version':'2022-06-28'},signal:AbortSignal.timeout(20000)});
 health.notion={http_status:notion.status,ready:false};
 if(notion.ok){const schema:any=await notion.json();const required=['Provider','Research Model','Category','Verification','Confidence','Estimated Credits','Actual Credits','Supporting Sources'];const missing=required.filter(name=>!schema.properties?.[name]);health.notion={http_status:200,ready:missing.length===0,missing_properties:missing};}
 }catch{health.notion={ready:false,error:'connectivity_unavailable'};}
 log('notion_schema_check',health.notion);
 for(const provider of ['scrapecreators','oriane']){
  try{const tools=await adapter.discover(provider);await pool.query('INSERT INTO trend_alexandria_catalog(provider,tools) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET tools=EXCLUDED.tools,checked_at=now(),error=NULL',[provider,JSON.stringify(tools)]);
   log('catalogue_verified',{provider,count:tools.length,tools:tools.filter(t=>/^(tiktok|instagram|youtube)\//.test(t.capability)).map(t=>({capability:t.capability,credits:t.creditsCost,maximum:t.billing?.maxCredits})),discovery_credits:0});
  }catch(e){const error=e instanceof Error?e.message:'Catalogue failed';await pool.query('INSERT INTO trend_alexandria_catalog(provider,error) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET checked_at=now(),error=EXCLUDED.error',[provider,error]);log('catalogue_unavailable',{provider,error});health.catalogue_error=error;}
 }
 ready=true;log('research_worker_ready',health);await recordHealth();void tick();setInterval(()=>void tick(),10000).unref();
}
async function recordHealth(){await pool.query("INSERT INTO integrations(provider,data) VALUES('alexandria_worker',$1) ON CONFLICT(provider) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",[JSON.stringify({...health,ready,checked_at:new Date().toISOString()})]);}
async function tick(){
 if(busy||!ready)return;busy=true;health.busy=true;const db=await pool.connect();let locked=false;
 try{
  // Shared with the old service during cutover: one consumer/Notion writer at a time.
  locked=Boolean((await db.query('SELECT pg_try_advisory_lock(424249) AS locked')).rows[0].locked);if(!locked)return;
  health.last_tick=new Date().toISOString();
  await processResearchQueue(pool,db,workerId,log);
  await db.query("UPDATE trend_sources SET status='Expired',notion_synced_at=NULL WHERE status='Active' AND last_trend_evidence_at<now()-interval '7 days'");
  for(const row of (await db.query("SELECT * FROM trend_sources WHERE notion_synced_at IS NULL ORDER BY last_checked DESC LIMIT 10")).rows){try{await syncNotion(db,row);}catch{log('notion_sync_pending',{source_id:row.id});}}
  try{await reconcileUsage(db);}catch{log('usage_reconciliation_pending');}
  health.error=null;
 }catch(e){health.error=e instanceof Error?e.message.slice(0,200):'Worker failed';log('worker_error',{error:health.error});}
 finally{if(locked)await db.query('SELECT pg_advisory_unlock(424249)').catch(()=>{});db.release();busy=false;health.busy=false;await recordHealth().catch(()=>{});}
}
start().catch(e=>{log('startup_failed',{error:e instanceof Error?e.message:'startup failed'});process.exit(1);});
