/** Additive Motion-owned reverse-production API. All provider dispatch is in the existing worker. */
import type {Hono,Context,Next} from 'hono';
import type pg from 'pg';
import {Readable} from 'node:stream';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {ProjectInput,ProductionPlan,Approval,ShotId,validatePlan,revision,sha,assertApproval} from './reverse-contract.js';
import {sealUpload,readPrivateAsset,streamPrivateAsset,keyId} from './reverse-storage.js';
import {VISION_MODELS,PLANNER_MODELS,ROUTER,PLANNER_SYSTEM,QA_SYSTEM,visionPayload,routerRate,routerEstimate,generationTask} from './reverse-providers.js';
import {falPrices} from './text-video.js';
import {catalogModels} from './reverse-catalog.js';
import {registerPromptRoutes,promptModel,verifyOpenAIModel} from './reverse-prompts.js';
const P='/app/api/reverse',UUID=z.string().uuid();
type Options={openaiModelCheck?:()=>Promise<void>;guard:(c:Context,next:Next)=>Promise<any>;prices?:typeof falPrices;tokenRate?:typeof routerRate;upload?:typeof sealUpload;asset?:typeof readPrivateAsset};
export function registerReverse(app:Hono,pool:pg.Pool,options:Options){
  const prices=options.prices||falPrices,tokenRate=options.tokenRate||routerRate;
  const guard=async(c:Context,next:Next)=>{
    c.header('Cache-Control','private, no-store');
    const expected=process.env.MOTION_REVERSE_BRIDGE_TOKEN||'',actual=c.req.header('x-reverse-bridge-token')||'';
    if(expected&&actual&&Buffer.byteLength(expected)===Buffer.byteLength(actual)&&timingSafeEqual(Buffer.from(expected),Buffer.from(actual)))return next();
    return options.guard(c,next);
  };
  const fail=(c:Context,e:unknown)=>c.json({error:e instanceof Error?e.message:'Reverse operation failed'},409);
  const project=async(id:string,cl:any=pool,lock=false)=>{UUID.parse(id);const row=(await cl.query('SELECT * FROM reverse_projects WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!row)throw Error('Project not found');return row;};
  const worker=async(db:any=pool)=>{const row=(await db.query("SELECT data,updated_at FROM integrations WHERE provider='reverse_worker'")).rows[0];if(!row||Date.now()-Date.parse(row.updated_at)>120000)throw Error('Reverse worker not ready');return row.data;};
  async function queue(cl:any,p:any,action:string,data:any,idempotency:string){
    const pkg={creative:{reverse:true},reverse:{schema:'motion.reverse.job.v1',project_id:p.id,source_sha256:p.source_sha256,action,...data}};
    const old=(await cl.query('SELECT * FROM jobs WHERE idempotency_key=$1',[idempotency])).rows[0];
    if(old){if(old.package_sha256!==sha(pkg))throw Error('Idempotency key belongs to different inputs');return old;}
    return (await cl.query("INSERT INTO jobs(kind,status,package,package_sha256,idempotency_key,budget_credits,max_attempts) VALUES('reverse','NEW',$1,$2,$3,0,3) RETURNING *",[JSON.stringify(pkg),sha(pkg),idempotency])).rows[0];
  }
  app.get(P+'/config',guard,async c=>{let w=null;try{w=await worker();}catch{}const recipes=(await pool.query('SELECT id,name,version,validated FROM reverse_recipes ORDER BY name,version DESC')).rows;return c.json({schema:'motion.reverse.api.v1',primary_backend:'motion',worker:w,vision_models:VISION_MODELS,planner_models:PLANNER_MODELS,video_models:catalogModels(),recipes,storage_configured:!!process.env.MOTION_REVERSE_STORAGE_KEY,paid_dispatch:'quote_then_owner_approval',legacy_unchanged:true,prompt_brain:{provider:'openai',model:promptModel(),configured:!!w?.openai,input:'timestamped_frames',max_range_s:15},key_management:'railway'});});
  app.get(P+'/projects',guard,async c=>c.json({projects:(await pool.query('SELECT id,origin_key,title,status,source_sha256,current_revision,created_at,updated_at FROM reverse_projects ORDER BY created_at DESC LIMIT 100')).rows}));
  app.post(P+'/projects',guard,async c=>{try{const input=ProjectInput.parse(await c.req.json()),old=(await pool.query('SELECT * FROM reverse_projects WHERE origin_key=$1',[input.origin_key])).rows[0];if(old){if(old.source_sha256!==input.source.sha256)throw Error('Original source changed; create a new project');return c.json(old);}
    const p=(await pool.query('INSERT INTO reverse_projects(origin_key,title,source_sha256,source) VALUES($1,$2,$3,$4) RETURNING *',[input.origin_key,input.title,input.source.sha256,JSON.stringify(input.source)])).rows[0];return c.json(p,201);
  }catch(e){return fail(c,e);}});
  app.get(P+'/projects/:id',guard,async c=>{try{const p=await project(c.req.param('id')),v=p.current_revision?(await pool.query('SELECT plan FROM reverse_versions WHERE project_id=$1 AND revision=$2',[p.id,p.current_revision])).rows[0]?.plan:null;
    const assets=(await pool.query('SELECT id,shot_id,role,sha256,bytes,content_type,metadata,created_at FROM reverse_assets WHERE project_id=$1 ORDER BY created_at',[p.id])).rows;
    const jobs=(await pool.query("SELECT id,status,stage,progress,error,result,package->'reverse'->>'action' AS action,created_at FROM jobs WHERE kind='reverse' AND package->'reverse'->>'project_id'=$1 ORDER BY created_at DESC LIMIT 50",[p.id])).rows;
    return c.json({...p,plan:v,assets,jobs,analysis_sha256:sha(p.analysis)});
  }catch(e){return fail(c,e);}});
  app.put(P+'/projects/:id/source',guard,async c=>{const cl=await pool.connect();try{await cl.query('BEGIN');const p=await project(c.req.param('id'),cl,true);if(p.source_asset_id){await cl.query('COMMIT');return c.json({asset_id:p.source_asset_id,cached:true});}
    if(!c.req.raw.body)throw Error('Missing source body');const id=randomUUID(),sealed=await(options.upload||sealUpload)(Readable.fromWeb(c.req.raw.body as any),`reverse-private/${p.id}/${id}.sealed`,p.source_sha256,p.source.bytes);
    if(sealed.bytes!==p.source.bytes)throw Error('Uploaded source size changed');
    await cl.query("INSERT INTO reverse_assets(id,project_id,role,storage_key,sha256,bytes,content_type,encryption) VALUES($1,$2,'source',$3,$4,$5,$6,$7)",[id,p.id,sealed.storage_key,sealed.sha256,sealed.bytes,p.source.content_type,JSON.stringify(sealed.encryption)]);
    await cl.query("UPDATE reverse_projects SET source_asset_id=$2,status='source_ready',updated_at=now() WHERE id=$1",[p.id,id]);await cl.query('COMMIT');return c.json({asset_id:id},201);
  }catch(e){await cl.query('ROLLBACK');return fail(c,e);}finally{cl.release();}});
  app.get(P+'/assets/:id',guard,async c=>{try{const id=UUID.parse(c.req.param('id')),a=(await pool.query('SELECT * FROM reverse_assets WHERE id=$1',[id])).rows[0];if(!a)throw Error('Asset not found');c.header('Content-Type',a.content_type);c.header('X-Content-Type-Options','nosniff');c.header('Content-Security-Policy',"default-src 'none'; sandbox");if(options.asset)return c.body(new Uint8Array(await options.asset(a)));return c.body(await streamPrivateAsset(a));}catch(e){return fail(c,e);}});
  app.post(P+'/projects/:id/reference',guard,async c=>{try{const p=await project(c.req.param('id')),input=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(1).max(8*1024*1024),content_type:z.enum(['image/png','image/jpeg','image/webp']),rights_confirmed:z.literal(true)}).strict().parse(JSON.parse(c.req.header('x-reference-metadata')||'{}'));
    if(!c.req.raw.body)throw Error('Missing reference image');const id=randomUUID(),sealed=await(options.upload||sealUpload)(Readable.fromWeb(c.req.raw.body as any),`reverse-private/${p.id}/${id}.sealed`,input.sha256,input.bytes);
    if(sealed.bytes!==input.bytes)throw Error('Reference size changed');await pool.query("INSERT INTO reverse_assets(id,project_id,role,storage_key,sha256,bytes,content_type,encryption,metadata) VALUES($1,$2,'owner_reference',$3,$4,$5,$6,$7,$8)",[id,p.id,sealed.storage_key,sealed.sha256,sealed.bytes,input.content_type,JSON.stringify(sealed.encryption),JSON.stringify({rights_confirmed:true})]);return c.json({asset_id:id},201);
  }catch(e){return fail(c,e);}});
  app.post(P+'/projects/:id/analyze',guard,async c=>{try{const p=await project(c.req.param('id'));if(!p.source_asset_id)throw Error('Upload source first');if(p.analysis)throw Error('Original analysis is immutable; create a new project for reanalysis');const w=await worker();if(!w.runtime?.installed)throw Error('Actual upstream runtime is not installed');const input=z.object({audio:z.boolean().default(true),ocr:z.boolean().default(false),asr:z.boolean().default(false)}).strict().parse(await c.req.json());const job=await queue(pool,p,'analyze',{options:input},'reverse:analyze:'+p.id);return c.json({job_id:job.id,status:job.status,paid_requests:0},202);}catch(e){return fail(c,e);}});
  app.put(P+'/projects/:id/plan',guard,async c=>{const cl=await pool.connect();try{await cl.query('BEGIN');const p=await project(c.req.param('id'),cl,true),plan=validatePlan(await c.req.json(),p);if(plan.origin!=='user'&&plan.origin!=='repair')throw Error('Owner edit route cannot impersonate a planner');if(plan.base_revision!==p.current_revision)throw Error('Another edit was saved; reload before saving');const rev=revision(plan);
    await cl.query('INSERT INTO reverse_versions(project_id,revision,parent_revision,origin,plan) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[p.id,rev,p.current_revision,plan.origin,JSON.stringify(plan)]);
    await cl.query("UPDATE reverse_projects SET current_revision=$2,status='planned',updated_at=now() WHERE id=$1",[p.id,rev]);await cl.query('COMMIT');return c.json({revision:rev,plan});}catch(e){await cl.query('ROLLBACK');return fail(c,e);}finally{cl.release();}});
  app.get(P+'/projects/:id/versions',guard,async c=>{try{const p=await project(c.req.param('id'));return c.json({versions:(await pool.query('SELECT * FROM reverse_versions WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',[p.id])).rows});}catch(e){return fail(c,e);}});
  app.post(P+'/jobs/:id/resume',guard,async c=>{const cl=await pool.connect();try{await cl.query('BEGIN');const id=UUID.parse(c.req.param('id')),job=(await cl.query("SELECT * FROM jobs WHERE id=$1 AND kind='reverse' FOR UPDATE",[id])).rows[0];if(!job||job.status!=='FAILED')throw Error('Only a failed reverse job can resume');
    const calls=(await cl.query('SELECT * FROM creative_calls WHERE job_id=$1',[id])).rows;
    if(calls.some((x:any)=>['started','uncertain'].includes(x.status)&&!(['fal','openai'].includes(x.provider)&&x.provider_id)))throw Error('Unknown POST outcome requires provider reconciliation; no automatic re-send');
    if(job.package.reverse.quote&&Date.parse(job.package.reverse.quote.valid_until)<=Date.now()){
      const q=job.package.reverse.quote,done=new Set((await cl.query("SELECT slot FROM reverse_steps WHERE job_id=$1 AND status='complete'",[id])).rows.map((x:any)=>x.slot));
      const remaining=q.tasks.filter((t:any)=>t.provider!=='local'&&!done.has(t.slot));
      if(!remaining.every((t:any)=>['fal','openai'].includes(t.provider)&&calls.some((x:any)=>x.call_key==='reverse:'+q.binding+':'+t.slot&&x.provider_id&&['started','uncertain','complete','reconciled'].includes(x.status))))throw Error('Approval expired; only saved accepted requests can be polled, no new paid steps');
    }
    await cl.query("UPDATE jobs SET status='NEW',attempts=0,error=NULL,locked_by=NULL,locked_until=NULL,updated_at=now() WHERE id=$1",[id]);await cl.query('COMMIT');return c.json({job_id:id,status:'NEW'},202);
  }catch(e){await cl.query('ROLLBACK');return fail(c,e);}finally{cl.release();}});
  app.post(P+'/projects/:id/quote',guard,async c=>{try{
    const p=await project(c.req.param('id')),w=await worker();if(!p.analysis)throw Error('Run measured analysis first');if(!w.fal||!w.key_fingerprints?.fal)throw Error('Motion worker Fal key unavailable');
    const input=z.object({purpose:z.enum(['vision','planner','generate','repair','visual_qa','image']),shot_ids:z.array(ShotId).min(1).max(200),model:z.string().max(250).optional(),instructions:z.string().max(8000).default(''),asset_id:z.string().uuid().optional(),recipe_id:z.string().uuid().optional()}).strict().parse(await c.req.json());
    if(new Set(input.shot_ids).size!==input.shot_ids.length)throw Error('Duplicate shot selection');
    const measured=input.shot_ids.map(id=>{const s=p.analysis.shots.find((x:any)=>x.id===id);if(!s)throw Error('Unknown shot');return s;});const tasks:any[]=[],blockers:string[]=[];
    const planForRates=p.current_revision?(await pool.query('SELECT plan FROM reverse_versions WHERE project_id=$1 AND revision=$2',[p.id,p.current_revision])).rows[0]?.plan:null;
    const extraEndpoints=['generate','repair'].includes(input.purpose)?(planForRates?.shots||[]).filter((s:any)=>input.shot_ids.includes(s.shot_id)&&s.method!=='code'&&!['h3_max','grok_15'].includes(s.model)).map((s:any)=>s.model):[];
    const endpoints=[...new Set<string>([input.purpose==='image'?'fal-ai/flux/schnell':input.purpose==='vision'||input.purpose==='planner'||input.purpose==='visual_qa'?ROUTER:'minimax/h3-max/text-to-video',...(input.purpose==='generate'||input.purpose==='repair'?['minimax/h3-max/image-to-video','xai/grok-imagine-video/v1.5/text-to-video','xai/grok-imagine-video/v1.5/image-to-video']:[]),...extraEndpoints])];
    const rates=[];for(let offset=0;offset<endpoints.length;offset+=50)rates.push(...await prices(endpoints.slice(offset,offset+50)));
    if(input.purpose==='image'){
      if(measured.length!==1||input.instructions.trim().length<10)throw Error('Write the new reference-image prompt for exactly one shot');
      const live=rates.find(r=>r.endpoint_id==='fal-ai/flux/schnell');if(!live||live.currency!=='USD'||live.unit!=='megapixels'||!(live.unit_price>0))throw Error('Image price unavailable');
      // Round 1.048576 MP upward conservatively; one image, no source pixels.
      tasks.push({slot:'image:'+measured[0].id,role:'image',shot_id:measured[0].id,provider:'fal',endpoint:'fal-ai/flux/schnell',model:'fal-ai/flux/schnell',category:'image',rate:live,usd:2*live.unit_price,payload:{prompt:input.instructions,image_size:{width:1024,height:1024},num_images:1,num_inference_steps:4,enable_safety_checker:true,output_format:'png'},pricing_basis:'2 billable megapixels reserved for one 1024x1024 image; conservative estimate'});
    }else if(['vision','planner','visual_qa'].includes(input.purpose)){
      const model=input.model||(input.purpose==='planner'?PLANNER_MODELS[0]:VISION_MODELS[0]);if(input.purpose==='planner'&&!PLANNER_MODELS.includes(model))throw Error('Select a verified GPT/Claude planner');
      const live=rates.find(x=>x.endpoint_id===ROUTER);if(!live||live.unit!=='units'||live.currency!=='USD'||live.unit_price!==.01)throw Error('Router billing contract changed; quote blocked');
      const rate=await tokenRate(model,input.purpose!=='planner');
      if(input.purpose==='planner'){
        const recipeId=input.recipe_id||planForRates?.recipe_id||null;let recipe=null;if(recipeId){recipe=(await pool.query('SELECT id,name,version,manifest,validated FROM reverse_recipes WHERE id=$1',[recipeId])).rows[0];if(!recipe?.validated||!recipe.manifest?.resources)throw Error('Recipe needs a validated version with its actual Capsule resources; save a new version before planning');}
        const available=catalogModels().filter((m:any)=>m.available);
        const payload={model,system_prompt:PLANNER_SYSTEM,prompt:JSON.stringify({project_id:p.id,source_sha256:p.source_sha256,analysis_sha256:sha(p.analysis),base_revision:p.current_revision,recipe_id:recipeId,capsule_recipe:recipe,VIDEO_md:p.analysis.video_md,analysis:p.analysis,selected_shots:input.shot_ids,current_plan:planForRates,instructions:input.instructions,
          model_capabilities:available.map((m:any)=>({...m,route:'text-to-video',reference_images:false,settings_policy:'Only the verified preset resolution and duration options listed here.'})),
          reference_routes:[{id:'h3_max',roles:['first_frame','last_frame'],resolutions:['480P','768P','1080P'],max_seconds:15},{id:'grok_15',roles:['first_frame'],resolutions:['480p','720p','1080p'],max_seconds:15,max_prompt_chars:4096}],
          continuity_policy:'Owner selects a previously generated last frame or owned image explicitly before I2V. Set handoff_previous_frame=false; never invent future asset IDs or copy source pixels.',
          allowed_models:['h3_max','grok_15','motion-typed-graphics-v1',...available.map((m:any)=>m.id)]}),temperature:0,max_tokens:16000,reasoning:true,enable_web_search:false};
        tasks.push({slot:'planner',role:'planner',recipe_id:recipeId,provider:'fal',endpoint:ROUTER,model,category:'planning',payload,rate:live,token_rate:rate,...routerEstimate(payload,rate)});
      }else for(const shot of measured){
        if(input.purpose==='visual_qa'){
          const a=(await pool.query("SELECT * FROM reverse_assets WHERE project_id=$1 AND shot_id=$2 AND role='generated_shot' AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 1",[p.id,shot.id,input.asset_id||null])).rows[0];
          if(!a?.metadata?.qa_clip?.asset_id)throw Error('Generated clip is not prepared for bounded visual QA');
          if(a.metadata.revision!==p.current_revision)throw Error('Generated version belongs to a prior plan; inspect that revision before QA');
          const approved=planForRates.shots.find((s:any)=>s.shot_id===shot.id);
          const payload={model,system_prompt:QA_SYSTEM,prompt:JSON.stringify({shot_id:shot.id,approved_specification:approved,clip_duration_s:a.metadata.qa_clip.duration_s,stretch:a.metadata.qa_clip.stretch}),max_tokens:3000,temperature:0,reasoning:true,enable_web_search:false};
          tasks.push({slot:'visual_qa:'+shot.id,role:'visual_qa',shot_id:shot.id,generated_asset_id:a.id,provider:'fal',endpoint:ROUTER,model,category:'visual_qa',payload,clip:a.metadata.qa_clip,rate:live,token_rate:rate,...routerEstimate(payload,rate,a.metadata.qa_clip.duration_s)});continue;
        }
        if(!shot.clip?.asset_id)throw Error('Exact shot clip not prepared');const payload=visionPayload(p,shot,model);
        tasks.push({slot:'vision:'+shot.id,role:'vision',shot_id:shot.id,provider:'fal',endpoint:ROUTER,model,category:'vision',payload,clip:shot.clip,rate:live,token_rate:rate,...routerEstimate(payload,rate,shot.clip.duration_s)});
      }
    }else{
      if(!p.current_revision)throw Error('Save and inspect production plan first');const plan=(await pool.query('SELECT plan FROM reverse_versions WHERE project_id=$1 AND revision=$2',[p.id,p.current_revision])).rows[0]?.plan;validatePlan(plan,p);
      for(const s of measured){const shot=plan.shots.find((x:any)=>x.shot_id===s.id);if(!shot)throw Error('Selected shot is absent from current plan');
        const semantic=s.semantic;if(!semantic)throw Error('A real Vision observation is required before generation');
        for(const c of semantic.characters||[])if(!shot.characters[c.ref]||!shot.characters[c.ref].description.trim()&&!shot.characters[c.ref].keep_source)throw Error('Choose a replacement or explicitly keep each source character');
        if(semantic.location?.description&&(!shot.location||!shot.location.description.trim()&&!shot.location.keep_source))throw Error('Choose the remake location');
        for(const ref of shot.references){const a=(await pool.query('SELECT * FROM reverse_assets WHERE id=$1 AND project_id=$2',[ref.asset_id,p.id])).rows[0];if(!a)throw Error('Reference asset not found');if(['source','source_frame','shot_clip','audio_stem'].includes(a.role)&&!ref.allow_source_reference)throw Error('Source reference needs separate explicit consent');}
        const task=generationTask(shot,s,rates),frames=Math.round(s.end_s*30)-Math.round(s.start_s*30);if(frames<1)throw Error('Shot is shorter than the 30fps delivery frame; choose an explicit higher-fps production workflow');
        tasks.push({slot:'video:'+s.id,role:'video',shot_id:s.id,...task,shot_spec_hash:sha(shot),delivery:{fps:30,frames,duration_s:frames/30,timing_note:'Cumulative frame quantization; original measured timestamps remain unchanged.'}});
        let audioRates:any={};try{audioRates=JSON.parse(process.env.MOTION_CREATIVE_RATES_JSON||'{}');}catch{}
        for(const audio of shot.audio){
          const category=['narration','dialogue'].includes(audio.role)?'narration':audio.role,rate=audioRates[category];
          const valid=rate&&rate.model===audio.model&&rate.source&&Date.parse(rate.checked_at)>Date.now()-7*86400000&&Date.parse(rate.valid_until)>Date.now()&&Number.isFinite(rate.usd_per_unit)&&rate.usd_per_unit>0;
          if(!w.eleven||!valid){blockers.push(`ElevenLabs ${audio.role}: current verified model-specific price unavailable`);continue;}
          if(['narration','dialogue'].includes(audio.role)&&!audio.voice_id)throw Error('Choose an explicit voice ID');
          if(['narration','dialogue'].includes(audio.role)&&!['eleven_v4','eleven_v3','eleven_multilingual_v2'].includes(audio.model))throw Error('Speech model adapter not verified');
          if(audio.role==='sfx'&&!['eleven_text_to_sound_v3','eleven_text_to_sound_v2'].includes(audio.model)||audio.role==='music'&&audio.model!=='music_v1')throw Error('Audio model adapter not verified');
          if(audio.role==='music'&&audio.duration_s<3||audio.role==='sfx'&&(audio.duration_s<.5||audio.duration_s>30))throw Error('Audio duration is outside the verified provider constraint');
          const quantity=category==='narration'?Array.from(audio.text).length:category==='sfx'?audio.duration_s:1;
          tasks.push({slot:'audio:'+s.id+':'+audio.id,role:'audio',shot_id:s.id,provider:'elevenlabs',model:audio.model,category,usd:Math.ceil(quantity*rate.usd_per_unit*1.1*1e6)/1e6,payload:audio,rate,measured:s});
        }
      }
    }
    const total=Math.ceil(tasks.reduce((n,t)=>n+t.usd,0)*1e6)/1e6;
    const quote:any={id:randomUUID(),project_id:p.id,purpose:input.purpose,revision:p.current_revision||'none',source_sha256:p.source_sha256,analysis_sha256:sha(p.analysis),created_at:new Date().toISOString(),expires_at:new Date(Date.now()+900000).toISOString(),valid_until:new Date(Date.now()+8*3600000).toISOString(),tasks,total_usd:total,currency:'USD',key_fingerprints:w.key_fingerprints,blockers:[...new Set(blockers)],disclosure:{source:'Only selected exact shot clips are sent for Vision, slowed when short; audio excluded. Generation receives approved prompts/references only.',pricing:'Conservative estimate; provider invoice can differ. Unknown or changed prices block dispatch.',retention:'X-Fal-Store-IO:0 requested; downstream provider retention is not verified.'}};
    quote.binding=sha(quote);await pool.query('INSERT INTO reverse_quotes(id,project_id,purpose,revision,quote,binding,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[quote.id,p.id,quote.purpose,quote.revision,JSON.stringify(quote),quote.binding,quote.expires_at]);return c.json(quote);
  }catch(e){return fail(c,e);}});
  app.post(P+'/projects/:id/approve',guard,async c=>{const cl=await pool.connect();try{const input=Approval.parse(await c.req.json());await cl.query('BEGIN');const p=await project(c.req.param('id'),cl,true),row=(await cl.query('SELECT * FROM reverse_quotes WHERE id=$1 AND project_id=$2 FOR UPDATE',[input.quote_id,p.id])).rows[0];if(!row)throw Error('Quote not found');
    const old=(await cl.query('SELECT job_id FROM reverse_approvals WHERE quote_id=$1',[input.quote_id])).rows[0];if(old){await cl.query('COMMIT');return c.json(old);}
    const q=row.quote;assertApproval(q,input,p);const w=await worker(cl);if(sha(q.key_fingerprints)!==sha(w.key_fingerprints))throw Error('Provider key identity changed; quote again');
    const job=await queue(cl,p,q.purpose,{quote:q},'reverse:approved:'+q.id);
    await cl.query('INSERT INTO reverse_approvals(project_id,quote_id,binding,accepted_usd,source_confirmed,rights_confirmed,approval_origin,job_id) VALUES($1,$2,$3,$4,true,true,$5,$6)',[p.id,q.id,q.binding,q.total_usd,input.approval_origin,job.id]);
    if(q.total_usd>0){const draft=(await cl.query("INSERT INTO drafts(topic,status,creative) VALUES($1,'submitted',$2) RETURNING id",[p.title,JSON.stringify({reverse_project:p.id,quote_id:q.id})])).rows[0];const allocations:Record<string,number>={};for(const t of q.tasks)allocations[t.category]=(allocations[t.category]||0)+t.usd;
      await cl.query('INSERT INTO creative_approvals(draft_id,revision,quote,allocations,max_usd,job_id) VALUES($1,$2,$3,$4,$5,$6)',[draft.id,q.binding,JSON.stringify(q),JSON.stringify(allocations),q.total_usd,job.id]);}
    await cl.query("INSERT INTO job_events(job_id,status,message,data) VALUES($1,'NEW','Owner approved exact reverse-production quote',$2)",[job.id,JSON.stringify({quote_id:q.id,total_usd:q.total_usd,binding:q.binding})]);await cl.query('COMMIT');return c.json({job_id:job.id,status:job.status},202);
  }catch(e){await cl.query('ROLLBACK');return fail(c,e);}finally{cl.release();}});
  app.post(P+'/projects/:id/recipe',guard,async c=>{try{const p=await project(c.req.param('id')),input=z.object({name:z.string().regex(/^[a-z0-9_-]{1,80}$/),display_name:z.string().max(120).optional(),recipe:z.record(z.unknown()),reviewed:z.literal(true)}).strict().parse(await c.req.json());if(JSON.stringify(input).length>100000)throw Error('Recipe too large');const job=await queue(pool,p,'recipe',{recipe:input},'reverse:recipe:'+p.id+':'+sha(input));return c.json({job_id:job.id,paid_requests:0},202);}catch(e){return fail(c,e);}});
  app.post(P+'/projects/:id/assemble',guard,async c=>{try{const p=await project(c.req.param('id'));const input=z.object({revision:z.string().length(64),assets:z.record(z.string().uuid()),rights_confirmed:z.literal(true)}).strict().parse(await c.req.json());if(input.revision!==p.current_revision)throw Error('Plan changed before assembly');const job=await queue(pool,p,'assemble',input,'reverse:assemble:'+sha({project:p.id,...input}));return c.json({job_id:job.id,paid_requests:0},202);}catch(e){return fail(c,e);}});
  registerPromptRoutes(app,pool,{P,guard,project,worker,queue,fail,checkOpenAI:options.openaiModelCheck||verifyOpenAIModel});
  return {project,queue};
}
