import pg from 'pg';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {research} from './adapter.js';
import {saveEvidence} from '../../api/src/trends/store.js';
import {syncNotion} from '../../api/src/trends/notion.js';
import {reconcileUsage} from '../../api/src/trends/provider.js';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4});
const workerId=randomUUID();let ready=false,busy=false,lastTick:string|null=null,lastError:string|null=null;
const log=(event:string,fields:any={})=>console.log(JSON.stringify({event,at:new Date().toISOString(),...fields}));
const server=createServer((req,res)=>{if(req.url!=='/health'){res.writeHead(404).end();return;}res.writeHead(ready?200:503,{'Content-Type':'application/json'}).end(JSON.stringify({ok:ready,busy,last_tick:lastTick,last_error:lastError,adapter:'jev-social@0.1.13',socai:'0.6.18',schedule_enabled:process.env.TREND_RESEARCH_SCHEDULE_ENABLED==='1'}));});
server.listen(Number(process.env.PORT)||8080,'0.0.0.0');
async function migrate(){
  const db=await pool.connect();try{await db.query('SELECT pg_advisory_lock(424242)');const done=await db.query("SELECT 1 FROM schema_migrations WHERE name='030_trend_research.sql'");
    if(!done.rows.length){await db.query('BEGIN');await db.query(await readFile(new URL('../../api/migrations/030_trend_research.sql',import.meta.url),'utf8'));await db.query("INSERT INTO schema_migrations(name) VALUES('030_trend_research.sql')");await db.query('COMMIT');}
  }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.query('SELECT pg_advisory_unlock(424242)');db.release();}
}
async function tick(){
  if(busy)return;busy=true;const db=await pool.connect();let locked=false;
  try{
    // One worker across all replicas serializes cost reservations, browser and Notion
    // writes. Deliberately capped at one for the initial production release.
    locked=(await db.query('SELECT pg_try_advisory_lock(424249) AS locked')).rows[0].locked;if(!locked)return;
    lastTick=new Date().toISOString();
    try{for(const result of await reconcileUsage(db))log('provider_usage_reconciled',result);}catch{log('provider_reconciliation_unavailable');}
    await db.query("UPDATE trend_research_runs SET status='failed',error='Worker interrupted; paid requests are not automatically repeated',finished_at=now() WHERE status='running' AND heartbeat_at<now()-interval '12 minutes'");
    await db.query("UPDATE trend_sources SET status='Expired',notion_synced_at=NULL WHERE status='Active' AND last_trend_evidence_at<now()-interval '7 days'");
    if(process.env.TREND_RESEARCH_SCHEDULE_ENABLED==='1'){
      const slot=Math.floor(Date.now()/(6*3600000));
      const verified=(process.env.TREND_VERIFIED_PLATFORMS||'').split(',').filter(x=>['tiktok','instagram'].includes(x));
      for(const platform of verified)await db.query('INSERT INTO trend_research_runs(request_key,request) VALUES($1,$2) ON CONFLICT(request_key) DO NOTHING',[`schedule:${slot}:${platform}`,JSON.stringify({platform,query:process.env.TREND_DEFAULT_QUERY||'วิทยาศาสตร์ เรื่องใกล้ตัว เทคโนโลยี ไทย',limit:3})]);
    }
    const run=(await db.query("UPDATE trend_research_runs SET status='running',started_at=now(),heartbeat_at=now(),worker_id=$1 WHERE id=(SELECT id FROM trend_research_runs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *",[workerId])).rows[0];
    if(run){const started=Date.now();const heartbeat=setInterval(()=>{void pool.query('UPDATE trend_research_runs SET heartbeat_at=now() WHERE id=$1',[run.id]).catch(()=>{});},15000);
      try{
        log('research_started',{id:run.id,platform:run.request.platform});
        const result=await research(db,run);let eligible=0;
        for(const evidence of result.items){const row=await saveEvidence(db,run.id,evidence,result.assessments.get(evidence.sourceId)||{suitability:0,reason:'Assessment unavailable',summary:evidence.title,angles:[]});await syncNotion(db,row);if(row.status==='Active')eligible++;log('source_saved',{run_id:run.id,url:row.source_url,published_at:row.published_at,discovered_at:row.discovered_at,status:row.status,score:row.trend_score});}
        const status=result.status==='failed'?'failed':result.status==='blocked'?'blocked':result.status==='completed'?'done':'partial';
        await db.query('UPDATE trend_research_runs SET status=$2,finished_at=now(),duration_ms=$3,browser_actions=$4,evidence_count=$5,eligible_count=$6,details=$7,error=$8 WHERE id=$1',[run.id,status,Date.now()-started,result.browserActions,result.items.length,eligible,JSON.stringify({jev_status:result.status,reason:result.reason}),['failed','blocked'].includes(status)?result.reason:null]);
        lastError=['failed','blocked'].includes(status)?result.reason:null;
        log('research_finished',{id:run.id,status,evidence:result.items.length,eligible,browser_actions:result.browserActions,reason:result.reason});
      }catch(e){lastError=e instanceof Error?e.message.slice(0,300):'Research failed';await db.query("UPDATE trend_research_runs SET status='failed',finished_at=now(),duration_ms=$2,error=$3 WHERE id=$1",[run.id,Date.now()-started,lastError]);log('research_failed',{id:run.id,error:lastError});}finally{clearInterval(heartbeat);}
    }
    for(const row of (await db.query("SELECT * FROM trend_sources WHERE notion_synced_at IS NULL ORDER BY last_checked DESC LIMIT 10")).rows){try{await syncNotion(db,row);}catch(e){log('notion_sync_failed',{source_id:row.id,error:e instanceof Error?e.message:'sync failed'});}}
  }catch(e){lastError=e instanceof Error?e.message.slice(0,250):'Worker tick failed';log('worker_error',{error:lastError});}
  finally{if(locked)await db.query('SELECT pg_advisory_unlock(424249)').catch(()=>{});db.release();busy=false;}
}
async function start(){await migrate();
  const notion=await fetch('https://api.notion.com/v1/databases/'+process.env.NOTION_TREND_DATABASE_ID,{headers:{Authorization:'Bearer '+process.env.NOTION_TOKEN,'Notion-Version':'2022-06-28'},signal:AbortSignal.timeout(25000)});
  log('notion_connectivity',{ok:notion.ok,http_status:notion.status});
  if(!notion.ok)lastError='Notion database unavailable: HTTP '+notion.status;
  const bootstrap=JSON.parse(process.env.TREND_BOOTSTRAP_TESTS_JSON||'[]');
  for(const r of bootstrap.slice(0,4)){if(!['tiktok','instagram'].includes(r.platform)||!r.key||typeof r.query!=='string')throw new Error('Invalid bounded bootstrap research request');await pool.query('INSERT INTO trend_research_runs(request_key,request) VALUES($1,$2) ON CONFLICT(request_key) DO NOTHING',[r.key,JSON.stringify({platform:r.platform,query:r.query.slice(0,400),limit:Math.max(1,Math.min(6,r.limit||2)),probe_only:r.probe_only===true})]);}
  ready=true;log('worker_ready',{worker_id:workerId});void tick();setInterval(()=>void tick(),15000).unref();
}
start().catch(e=>{log('startup_failed',{error:e instanceof Error?e.message:'startup failure'});process.exitCode=1;server.close();void pool.end();});
process.on('SIGTERM',()=>{ready=false;server.close();const timer=setTimeout(()=>process.exit(0),10000);timer.unref();});
