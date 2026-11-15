import pg from 'pg';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {Alexandria,verifyResearchModel} from './alexandria.js';
import {randomUUID} from 'node:crypto';
import {runResearch} from './orchestrator.js';
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
 const model=await verifyResearchModel(process.env.TREND_RESEARCH_MODEL||'');health.model=model;
 log('research_model_verified',model);
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
  await db.query("UPDATE trend_alexandria_jobs j SET state='queued' FROM trend_research_runs r WHERE r.id=j.run_id AND j.state='running' AND r.heartbeat_at<now()-interval '12 minutes'");
  const job=(await db.query("UPDATE trend_alexandria_jobs SET state='running',updated_at=now() WHERE run_id=(SELECT run_id FROM trend_alexandria_jobs WHERE state='queued' ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *")).rows[0];
  if(job){
   const run=(await db.query("UPDATE trend_research_runs SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now(),worker_id=$2 WHERE id=$1 RETURNING *",[job.run_id,workerId])).rows[0];
   const timer=setInterval(()=>void pool.query('UPDATE trend_research_runs SET heartbeat_at=now() WHERE id=$1',[run.id]).catch(()=>{}),15000);const started=Date.now();
   log('research_started',{id:run.id,platform:run.request.platform});
   try{
    const result=await runResearch(pool,db,{...run,...job});
    await db.query('UPDATE trend_research_runs SET status=$2,finished_at=now(),duration_ms=$3,evidence_count=$4,eligible_count=$5,details=$6,error=NULL WHERE id=$1',[run.id,result.status,Date.now()-started,result.evidence_count,result.eligible_count,JSON.stringify(result.details)]);
    await db.query('UPDATE trend_alexandria_jobs SET state=$2,updated_at=now() WHERE run_id=$1',[run.id,result.status]);
    log('research_finished',{id:run.id,status:result.status,evidence:result.evidence_count,eligible:result.eligible_count,budget:result.details.budget});
   }catch(e){const error=e instanceof Error?e.message.slice(0,400):'Research failed';
    await db.query("UPDATE trend_research_runs SET status='failed',finished_at=now(),error=$2 WHERE id=$1",[run.id,error]);await db.query("UPDATE trend_alexandria_jobs SET state='failed',updated_at=now() WHERE run_id=$1",[run.id]);log('research_failed',{id:run.id,error});
   }finally{clearInterval(timer);}
  }
  await db.query("UPDATE trend_sources SET status='Expired',notion_synced_at=NULL WHERE status='Active' AND last_trend_evidence_at<now()-interval '7 days'");
  for(const row of (await db.query("SELECT * FROM trend_sources WHERE notion_synced_at IS NULL ORDER BY last_checked DESC LIMIT 10")).rows){try{await syncNotion(db,row);}catch{log('notion_sync_pending',{source_id:row.id});}}
  try{await reconcileUsage(db);}catch{log('usage_reconciliation_pending');}
  health.error=null;
 }catch(e){health.error=e instanceof Error?e.message.slice(0,200):'Worker failed';log('worker_error',{error:health.error});}
 finally{if(locked)await db.query('SELECT pg_advisory_unlock(424249)').catch(()=>{});db.release();busy=false;health.busy=false;await recordHealth().catch(()=>{});}
}
start().catch(e=>{log('startup_failed',{error:e instanceof Error?e.message:'startup failed'});process.exit(1);});
