import type pg from 'pg';

// This exact reservation represents our own Classic renderer, not a provider POST.
const LOCAL_RENDER="call_key='classic-render-v1' AND provider='infrastructure' AND model='classic' AND category='compute'";

export async function retryCreativeJob(pool:pg.Pool,id:string):Promise<{ok:boolean;id?:string;resumed?:boolean;status?:string;error?:string}>{
  const cl=await pool.connect();
  try{
    await cl.query('BEGIN');
    const job=(await cl.query("SELECT *,locked_until>now() AS lease_active FROM jobs WHERE id=$1 AND package ? 'creative' FOR UPDATE",[id])).rows[0];
    if(!job||job.status!=='FAILED')throw Error('Only failed jobs can resume');
    if(job.lease_active)throw Error('A worker still holds this job; wait for its current attempt to finish');
    const classic=job.kind==='episode'&&job.package?.creative?.engine==='classic';
    const uncertain=await cl.query(`SELECT 1 FROM creative_calls WHERE job_id=$1 AND status IN ('started','uncertain')
      AND NOT (provider='openai' AND provider_id IS NOT NULL)
      AND NOT ($2::boolean AND ${LOCAL_RENDER})`,[id,classic]);
    if(uncertain.rows.length)throw Error('Reconcile ambiguous provider calls before retry; no duplicate paid submission');
    if(classic)await cl.query(`UPDATE creative_calls SET status='reserved',updated_at=now() WHERE job_id=$1 AND status IN ('started','uncertain') AND ${LOCAL_RENDER}`,[id]);
    // Keep successful audio, renders and all paid reservations; only reopen the local attempt.
    await cl.query("UPDATE jobs SET status='NEW',error=NULL,attempts=0,locked_by=NULL,locked_until=NULL,finished_at=NULL,updated_at=now() WHERE id=$1",[id]);
    await cl.query('COMMIT');
    return {ok:true,id,resumed:true,status:'NEW'};
  }catch(e){
    await cl.query('ROLLBACK');
    return {ok:false,error:e instanceof Error?e.message:String(e)};
  }finally{cl.release();}
}
