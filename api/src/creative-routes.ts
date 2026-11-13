import type {Hono,Context,Next} from 'hono';
import type pg from 'pg';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {CreativeSettings,CreativePlan,chooseStyle,estimateCreative,releaseGates,LEMO_STYLES,publicStyles,CATEGORIES,hash} from './creative.js';

export function registerCreative(app:Hono,pool:pg.Pool,deps:{guard:(c:Context,n:Next)=>Promise<any>,prepare:(row:any)=>any,signAsset?:(key:string)=>Promise<string|null>}){
  const g=deps.guard;
  const rowFor=async(id:string)=>(await pool.query('SELECT * FROM drafts WHERE id=$1',[id])).rows[0];
  const rates=()=>{try{return JSON.parse(process.env.MOTION_CREATIVE_RATES_JSON||'{}');}catch{return {};}};
  const quote=(r:any)=>estimateCreative(r,deps.prepare(r),rates());
  app.get('/app/api/creative/capabilities',g,c=>c.json({...releaseGates(),styles:publicStyles(),defaults:{mode:process.env.LEMO_DEFAULT_STYLE_MODE||'auto',tts_model:process.env.MOTION_DEFAULT_TTS_MODEL||'eleven_v4',sfx_model:process.env.MOTION_DEFAULT_SFX_MODEL||'eleven_text_to_sound_v3'}}));
  app.get('/app/api/creative/:id/estimate',g,async c=>{
    const r=await rowFor(c.req.param('id'));if(!r?.creative||r.status!=='ready')return c.json({error:'Draft must be ready for review'},409);
    try{const q=quote(r);return c.json({...q,quote_hash:hash(q),gates:releaseGates()});}catch(e){return c.json({error:String(e)},422);}
  });
  app.patch('/app/api/creative/:id',g,async c=>{
    const b=await c.req.json(),cl=await pool.connect();
    try{
      await cl.query('BEGIN');const r=(await cl.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE',[c.req.param('id')])).rows[0];
      if(!r?.creative||r.status!=='ready')throw Error('Only ready drafts can be edited');
      const settings=CreativeSettings.parse({...r.creative.settings,...b.settings});
      if(settings.locked){settings.mode='manual';settings.manual_style=b.settings?.manual_style||r.creative.selection.selected.id;}
      if(r.creative.settings.locked&&b.settings?.manual_style&&b.settings.manual_style!==r.creative.settings.manual_style)throw Error('Unlock the style first');
      const board=structuredClone(r.storyboard);
      if(b.script){if(r.creative.engine!=='lemo')throw Error('Use Classic rewrite to keep its artwork synchronized');board.script=z.array(z.object({id:z.string(),text:z.string().min(3).max(500),beat:z.enum(['hook','rehook','info','payoff','cta'])}).strict()).min(1).max(14).parse(b.script);}
      const plan=CreativePlan.parse(b.plan||board.creative);
      if(r.creative.settings.locked&&hash(plan.identity)!==hash(r.storyboard.creative.identity))throw Error('Unlock the film identity before editing it');
      const selection=chooseStyle(plan,settings,board.script);
      if(r.creative.settings.locked&&selection.selected.id!==r.creative.selection.selected.id)throw Error('Locked identity cannot change');
      // A changed story cannot inherit semantic confidence from an earlier revision.
      if(b.script&&hash(b.script)!==hash(r.storyboard.script)){selection.low_confidence=true;selection.selected.confidence=0;}
      board.creative=plan;
      const creative={...r.creative,settings,selection,engine:settings.engine,edited:true};
      const draft={...r.draft,script:board.script,storyboard:board};
      await cl.query('UPDATE drafts SET creative=$2,storyboard=$3,draft=$4,updated_at=now() WHERE id=$1',[r.id,JSON.stringify(creative),JSON.stringify(board),JSON.stringify(draft)]);
      await cl.query('COMMIT');return c.json({ok:true,creative,storyboard:board});
    }catch(e){await cl.query('ROLLBACK');return c.json({error:String(e)},422);}finally{cl.release();}
  });
  app.post('/app/api/creative/:id/approve',g,async c=>{
    const parsed=z.object({revision:z.string(),quote_hash:z.string(),max_usd:z.number().positive().max(1000),allocations:z.record(z.number().min(0).max(1000)),unknown_ack:z.boolean(),style_ack:z.boolean().default(false)}).strict().safeParse(await c.req.json());
    if(!parsed.success)return c.json({error:'Invalid approval'},422);
    const b=parsed.data,cl=await pool.connect();
    try{
      await cl.query('BEGIN');const r=(await cl.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE',[c.req.param('id')])).rows[0];
      if(!r?.creative)throw Error('No creative project');
      const old=(await cl.query('SELECT job_id FROM creative_approvals WHERE draft_id=$1 AND revision=$2',[r.id,b.revision])).rows[0];
      if(old?.job_id){await cl.query('COMMIT');return c.json({id:old.job_id,duplicate:true});}
      if(r.status!=='ready')throw Error('Draft is not ready');
      if(r.creative.engine==='lemo'&&!releaseGates().enabled)throw Error('Lemo release gates are not cleared; development previews use mocks');
      const pkg=deps.prepare(r),q=estimateCreative(r,pkg,rates());
      if(q.revision!==b.revision||hash(q)!==b.quote_hash)throw Error('Story, rates or settings changed; review a new quote');
      if(q.unknown.length&&!b.unknown_ack)throw Error('Unknown prices require explicit bounded approval');
      if(r.creative.selection.low_confidence&&!b.style_ack)throw Error('Review uncertain style selection first');
      if(b.max_usd>r.creative.settings.max_usd)throw Error('Approval exceeds the project budget');
      if(Object.keys(b.allocations).some(k=>!CATEGORIES.includes(k as any)))throw Error('Unknown cost category');
      if(Object.values(b.allocations).reduce((a,v)=>a+v,0)>b.max_usd+.000001)throw Error('Allocations exceed budget');
      for(const item of q.items)if(item.quantity>0&&(!(b.allocations[item.category]>0)||b.allocations[item.category]<(item.estimated_usd||0)))throw Error(`Insufficient allocation for ${item.category}`);
      const episode=(await cl.query("INSERT INTO episodes(topic,title_th,status) VALUES($1,$2,'NEW') RETURNING id",[r.topic,pkg.title_th])).rows[0];
      const approval=(await cl.query('INSERT INTO creative_approvals(draft_id,revision,quote,allocations,max_usd,unknown_ack) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[r.id,q.revision,JSON.stringify(q),JSON.stringify(b.allocations),b.max_usd,b.unknown_ack])).rows[0];
      pkg.creative={...r.creative,approval_id:approval.id,revision:q.revision,allocations:b.allocations,max_usd:b.max_usd,rates:rates(),planning_usage:r.usage,model:r.model,reasoning:r.reasoning};
      const job=(await cl.query("INSERT INTO jobs(episode_id,kind,status,package,package_sha256,idempotency_key) VALUES($1,$2,'NEW',$3,$4,$5) RETURNING id",[episode.id,r.creative.engine==='lemo'?'lemo':'episode',JSON.stringify(pkg),hash(pkg),'creative:'+r.id+':'+q.revision])).rows[0];
      if(r.creative.reference_job){
        await cl.query('INSERT INTO creative_job_references(job_id,reference_id,name,look,reference_image,image_hash) SELECT $1,reference_id,name,look,reference_image,image_hash FROM creative_job_references WHERE job_id=$2',[job.id,r.creative.reference_job]);
      }else{
        const refs=(await cl.query('SELECT id,name,look,reference_image FROM characters WHERE id=ANY($1::uuid[])',[(r.characters||[]).map((x:any)=>x.id)])).rows;
        for(const ref of refs)if(ref.reference_image)await cl.query('INSERT INTO creative_job_references(job_id,reference_id,name,look,reference_image,image_hash) VALUES($1,$2,$3,$4,$5,$6)',[job.id,ref.id,ref.name,ref.look,ref.reference_image,hash(ref.reference_image)]);
      }
      await cl.query('UPDATE creative_approvals SET job_id=$2 WHERE id=$1',[approval.id,job.id]);
      await cl.query('INSERT INTO scripts(episode_id,segments,full_text) VALUES($1,$2,$3)',[episode.id,JSON.stringify(pkg.script),pkg.script.map((s:any)=>s.text).join(' ')]);
      for(let i=0;i<pkg.storyboard.length;i++)await cl.query('INSERT INTO scenes(episode_id,seg_id,position,storyboard) VALUES($1,$2,$3,$4)',[episode.id,pkg.storyboard[i].seg,i,JSON.stringify(pkg.storyboard[i])]);
      for(const s of pkg.sources)await cl.query('INSERT INTO research_sources(episode_id,url,publisher,claim,collected) VALUES($1,$2,$3,$4,$5)',[episode.id,s.url,s.publisher||null,s.claim||null,s.collected||null]);
      await cl.query("UPDATE drafts SET status='submitted',job_id=$2,episode_id=$3,updated_at=now() WHERE id=$1",[r.id,job.id,episode.id]);
      await cl.query('COMMIT');return c.json({id:job.id,episode_id:episode.id},201);
    }catch(e){await cl.query('ROLLBACK');return c.json({error:String(e)},409);}finally{cl.release();}
  });
  app.post('/app/api/creative/:id/regenerate-scene',g,async c=>{
    const r=await rowFor(c.req.param('id')),b=await c.req.json();
    if(r?.creative?.engine!=='lemo'||!r.creative.selection?.plan.scenes.some((s:any)=>s.seg===b.seg))return c.json({error:'Unknown Lemo scene'},422);
    // Immutable old job/package; a new reviewable draft reuses audio and other scene caches.
    const failed=r.job_id?(await pool.query('SELECT error FROM jobs WHERE id=$1',[r.job_id])).rows[0]:null;
    const source=r.job_id?(await pool.query("SELECT storage_key FROM assets WHERE job_id=$1 AND kind='lemo_source' AND meta->>'seg'=$2 ORDER BY id DESC LIMIT 1",[r.job_id,b.seg])).rows[0]:null;
    const creative={...r.creative,scene_repairs:{...r.creative.scene_repairs,[b.seg]:{error:failed?.error,source_key:source?.storage_key}},reference_job:r.job_id||r.creative.reference_job,scene_nonces:{...r.creative.scene_nonces,[b.seg]:randomUUID()}};
    const copy=(await pool.query(`INSERT INTO drafts(topic,note,status,parent_id,model,reasoning,story_mode,source_text,characters,storyboard,draft,research,research_job_id,creative,narration_style,narration_custom,presenter_kind,director_version,presentation_version,usage)
      VALUES($1,$2,'ready',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,[r.topic,r.note,r.id,r.model,r.reasoning,r.story_mode,r.source_text,JSON.stringify(r.characters||[]),JSON.stringify(r.storyboard),JSON.stringify(r.draft),JSON.stringify(r.research||[]),r.research_job_id||r.id,JSON.stringify(creative),r.narration_style,r.narration_custom,r.presenter_kind,r.director_version,r.presentation_version,JSON.stringify(r.usage||{})])).rows[0];
    return c.json({id:copy.id,requires_approval:true},201);
  });
  app.get('/app/api/creative/jobs/:id',g,async c=>{
    const r=(await pool.query("SELECT id,status,stage,progress,error,result,stage_results,qa_report,package->'creative' AS creative FROM jobs WHERE id=$1 AND package ? 'creative'",[c.req.param('id')])).rows[0];
    if(!r)return c.json({error:'Not found'},404);
    const calls=(await pool.query('SELECT call_key,provider,model,category,reserved_usd,actual_usd,status,usage,provider_id FROM creative_calls WHERE job_id=$1 ORDER BY created_at',[r.id])).rows;
    const assets=(await pool.query('SELECT id,kind,storage_key,meta FROM assets WHERE job_id=$1',[r.id])).rows;
    return c.json({...r,calls,assets:await Promise.all(assets.map(async a=>({...a,url:deps.signAsset?await deps.signAsset(a.storage_key):null})))});
  });
  app.post('/app/api/creative/jobs/:id/cancel',g,async c=>{
    const r=await pool.query("UPDATE jobs SET status='CANCELLED',updated_at=now() WHERE id=$1 AND package ? 'creative' AND status NOT IN ('READY_TO_POST','CANCELLED') RETURNING id",[c.req.param('id')]);
    return c.json({cancelled:!!r.rowCount,note:'Already submitted provider requests may still incur costs; completed assets are retained'});
  });
  app.post('/app/api/creative/jobs/:id/retry',g,async c=>{
    const cl=await pool.connect();try{
      await cl.query('BEGIN');const job=(await cl.query("SELECT * FROM jobs WHERE id=$1 AND package ? 'creative' FOR UPDATE",[c.req.param('id')])).rows[0];
      if(!job||job.status!=='FAILED')throw Error('Only failed jobs can resume');
      if((await cl.query("SELECT 1 FROM creative_calls WHERE job_id=$1 AND status IN ('started','uncertain') AND NOT (provider='openai' AND provider_id IS NOT NULL)",[job.id])).rowCount)throw Error('Reconcile ambiguous provider calls before retry; no duplicate paid submission');
      await cl.query("UPDATE jobs SET status='NEW',error=NULL,locked_by=NULL,locked_until=NULL,updated_at=now() WHERE id=$1",[job.id]);await cl.query('COMMIT');return c.json({id:job.id,resumed:true});
    }catch(e){await cl.query('ROLLBACK');return c.json({error:String(e)},409);}finally{cl.release();}
  });
  app.post('/app/api/creative/jobs/:id/reconcile',g,async c=>{
    const b=z.object({call_key:z.string().min(1).max(160),actual_usd:z.number().min(0).max(10000),receipt:z.string().min(8).max(2000)}).strict().safeParse(await c.req.json());
    if(!b.success)return c.json({error:'A completed call, actual amount and receipt reference are required'},422);
    // Owner-supplied invoice evidence is labelled separately from provider usage.
    // An ambiguous request without assets cannot be cleared just by declaring a cost.
    const r=await pool.query("UPDATE creative_calls SET actual_usd=$3,status='reconciled',usage=coalesce(usage,'{}')||$4::jsonb,updated_at=now() WHERE job_id=$1 AND call_key=$2 AND status IN ('complete','reconciled') RETURNING actual_usd,reserved_usd",[c.req.param('id'),b.data.call_key,b.data.actual_usd,JSON.stringify({reconciliation_source:'owner_receipt',receipt:b.data.receipt})]);
    return r.rowCount?c.json({ok:true,over_reservation:Number(r.rows[0].actual_usd)>Number(r.rows[0].reserved_usd)}):c.json({error:'Reconcile provider outcome and restore missing assets first'},409);
  });
}
