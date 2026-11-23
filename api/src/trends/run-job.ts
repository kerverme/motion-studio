import type pg from 'pg';
import {runResearch} from './orchestrator.js';
import {ResearchResponsePending} from './provider.js';
import type {Queryable} from './store.js';

// Called while holding the shared consumer lock. Each turn may hand an accepted response back to the queue.
export async function processResearchQueue(pool:pg.Pool, db:Queryable, workerId:string, log:(event:string,data:any)=>void) {
  await db.query(`UPDATE trend_alexandria_jobs j SET state='queued',updated_at=now() FROM trend_research_runs r
    WHERE j.run_id=r.id AND j.state='running' AND (r.worker_id IS DISTINCT FROM $1 OR r.heartbeat_at<now()-interval '12 minutes')`,[workerId]);
  const job=(await db.query(`UPDATE trend_alexandria_jobs SET state='running',updated_at=now()
    WHERE run_id=(SELECT run_id FROM trend_alexandria_jobs WHERE state='queued' ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows[0];
  if(!job)return;
  const run=(await db.query(`UPDATE trend_research_runs SET status='running',started_at=COALESCE(started_at,now()),finished_at=NULL,
    error=NULL,heartbeat_at=now(),worker_id=$2 WHERE id=$1 RETURNING *`,[job.run_id,workerId])).rows[0];
  const timer=setInterval(()=>void pool.query('UPDATE trend_research_runs SET heartbeat_at=now() WHERE id=$1',[run.id]).catch(()=>{}),15000);
  if(!run.details?.openai_stage)log('research_started',{id:run.id,platform:run.request.platform});
  try {
    const result=await runResearch(pool,db,{...run,...job});
    const duration=Math.min(2147483647,Math.max(0,Date.now()-new Date(run.started_at).getTime()));
    await db.query(`WITH finished AS (
      UPDATE trend_research_runs SET status=$2,finished_at=now(),duration_ms=$3,evidence_count=$4,eligible_count=$5,details=$6,error=NULL WHERE id=$1 RETURNING id)
      UPDATE trend_alexandria_jobs SET state=$2,updated_at=now() WHERE run_id IN (SELECT id FROM finished)`,
      [run.id,result.status,duration,result.evidence_count,result.eligible_count,JSON.stringify(result.details)]);
    log('research_finished',{id:run.id,status:result.status,evidence:result.evidence_count,eligible:result.eligible_count,budget:result.details.budget});
  } catch(error) {
    if(error instanceof ResearchResponsePending){
      await db.query(`WITH waiting AS (
        UPDATE trend_research_runs SET details=details || jsonb_build_object('openai_stage',$2::text),heartbeat_at=now() WHERE id=$1 RETURNING id)
        UPDATE trend_alexandria_jobs SET state='queued',updated_at=now() WHERE run_id IN (SELECT id FROM waiting)`,[run.id,error.stage]);
      if(run.details?.openai_stage!==error.stage)log('research_waiting_for_openai',{id:run.id,stage:error.stage});
    }else{
      const message=error instanceof Error?error.message.slice(0,400):'Research failed';
      await db.query(`WITH failed AS (
        UPDATE trend_research_runs SET status='failed',finished_at=now(),error=$2 WHERE id=$1 RETURNING id)
        UPDATE trend_alexandria_jobs SET state='failed',updated_at=now() WHERE run_id IN (SELECT id FROM failed)`,[run.id,message]);
      log('research_failed',{id:run.id,error:message});
    }
  } finally {clearInterval(timer);}
}
