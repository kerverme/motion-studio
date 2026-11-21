// Job summaries omit inputs, provider responses and credentials.
export const jobFields = `
  id,status,stage,progress,error,created_at,updated_at,finished_at,
  package->'reverse'->>'project_id' AS project_id,
  package->'reverse'->>'action' AS action,
  COALESCE(package#>>'{reverse,selection_id}',package#>>'{reverse,quote,tasks,0,selection_id}') AS selection_id,
  COALESCE(package#>>'{reverse,quote,range_input,version_id}',package#>>'{reverse,quote,tasks,0,payload,context,version_id}',package#>>'{reverse,quote,tasks,0,payload,version_id}') AS version_id,
  COALESCE(package#>>'{reverse,quote,range_input,variant}',CASE WHEN package#>>'{reverse,action}'='scene_logic' THEN
    CASE WHEN package#>'{reverse,quote,tasks,0,payload,context,replacements}'='{"characters":{},"locations":{}}'::jsonb THEN 'a' ELSE 'b' END END) AS variant,
  package#>>'{reverse,quote,total_usd}' AS approved_usd,
  package#>>'{reverse,quote,id}' AS quote_id,
  stage_results->'_reverse_progress' AS live_progress,
  stage_results->'_reverse_credit' AS credit_error,
  (package#>>'{reverse,action}'='scene_logic' AND status='FAILED' AND error LIKE '%Unknown spatial reference%') AS can_recover,
  (locked_by IS NOT NULL) AS claimed,
  CASE WHEN locked_by IS NOT NULL THEN locked_until - interval '10 minutes' END AS worker_seen_at`;

// Compare immutable work inside the project's FOR UPDATE lock. Different quote IDs,
// prices and expiry times authorize the same provider input only once.
export async function approvedMatch(db:any,projectId:string,q:any){
  if(!['prompt_extract','prompt_character','scene_logic','prompt_video'].includes(q.purpose))return null;
  const inputs=q.tasks.map((t:any)=>[t.role,t.model,t.endpoint??null,t.selection_id??null,t.payload]);
  const row=await db.query(`SELECT j.id AS job_id,j.status FROM reverse_approvals a
    JOIN reverse_quotes old ON old.id=a.quote_id JOIN jobs j ON j.id=a.job_id
    WHERE a.project_id=$1 AND old.purpose=$2 AND old.quote->>'source_sha256' IS NOT DISTINCT FROM $3
    AND (old.quote->'key_fingerprints')=$4::jsonb
    AND (old.quote->'range_input') IS NOT DISTINCT FROM $5::jsonb
    AND (old.quote->'scene_logic') IS NOT DISTINCT FROM $6::jsonb
    AND (SELECT jsonb_agg(jsonb_build_array(t->'role',t->'model',t->'endpoint',t->'selection_id',t->'payload') ORDER BY n)
         FROM jsonb_array_elements(old.quote->'tasks') WITH ORDINALITY AS x(t,n))=$7::jsonb
    AND NOT (j.status='FAILED' AND COALESCE(j.stage_results#>>'{_reverse_credit,rejected_before_acceptance}','false')='true'
             AND $8::timestamptz>COALESCE(j.finished_at,j.updated_at))
    ORDER BY CASE WHEN j.status IN ('FAILED','CANCELLED') THEN 1 ELSE 0 END,j.created_at DESC LIMIT 1`,
    [projectId,q.purpose,q.source_sha256??null,JSON.stringify(q.key_fingerprints),
     q.range_input?JSON.stringify(q.range_input):null,q.scene_logic?JSON.stringify(q.scene_logic):null,JSON.stringify(inputs),q.created_at]);
  return row.rows[0]||null;
}
