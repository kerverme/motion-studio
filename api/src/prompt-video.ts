// The guided path renders the selected time range as one approved text-to-video request.
import {z} from 'zod';
import {effectiveReplacements} from './scene-logic.js';
import {promptModel} from './reverse-prompts.js';
import {sha} from './reverse-contract.js';
import {compileExport} from './prompt-export.js';
import {applySceneExport,latestScene,sceneGraph} from './scene-routes.js';
import {VIDEO_MODELS,money,type Rate} from './text-video-contract.js';

export const guidedModel=VIDEO_MODELS[0];
const inputSchema=z.object({
  version_id:z.string().length(64),graph_id:z.string().length(64),variant:z.enum(['a','b']),
  main_character_id:z.string().regex(/^C[1-9][0-9]?$/).optional()
}).strict();

async function rangeVersions(db:any,pid:string,selection:string){
    const base=(await db.query(`SELECT * FROM reverse_prompt_versions WHERE selection_id=$1 AND project_id=$2
      AND replacements->'characters'='{}'::jsonb AND replacements->'locations'='{}'::jsonb
      ORDER BY (document ? 'audio') DESC,created_at DESC,id DESC LIMIT 1`,[selection,pid])).rows[0];
    const remake=base?(await db.query(`SELECT * FROM reverse_prompt_versions WHERE selection_id=$1 AND project_id=$2 AND locks_hash=$3
      AND (replacements->'characters'<>'{}'::jsonb OR replacements->'locations'<>'{}'::jsonb)
      ORDER BY created_at DESC,id DESC LIMIT 1`,[selection,pid,base.locks_hash])).rows[0]:null;
    return {base,remake};
}

async function rangeRequest(db:any,p:any,input:z.infer<typeof inputSchema>){
  const {g,v}=await sceneGraph(db,p,input.graph_id);
  const versions=await rangeVersions(db,p.id,v.selection_id);
  if((input.variant==='a'?versions.base:versions.remake)?.id!==input.version_id)throw Error('มี Prompt เวอร์ชันใหม่แล้ว กรุณาเปิดผลงานปัจจุบันและดูราคาอีกครั้ง');
  if(v.id!==input.version_id||(await latestScene(db,v,input.main_character_id))?.id!==g.id)
    throw Error('ผลตรวจฉากเปลี่ยนแล้ว กรุณาดูราคาใหม่');
  const source=p.analysis.source,endpoint=guidedModel.t2v;
  const compiled=applySceneExport(compileExport(v.document,v.replacements,endpoint,source,undefined,input.main_character_id),v,g,source,undefined,input.main_character_id);
  if(compiled.blockers.length)throw Error(compiled.blockers.join(' · '));
  if(input.variant==='b'&&g.review?.overrides?.length)throw Error('เวอร์ชันนี้มีการแก้เหตุการณ์ เปิดเครื่องมือขั้นสูงเพื่อตรวจเวอร์ชันก่อนผลิต');
  const selection=(await db.query('SELECT request FROM reverse_prompt_selections WHERE project_id=$1 AND id=$2',[p.id,v.selection_id])).rows[0];
  if(!selection)throw Error('ไม่พบช่วงต้นฉบับ');
  const payload={...compiled.settings,prompt:input.variant==='a'?compiled.prompt_a:compiled.prompt_b};
  const binding={...input,graph_id:g.id,input_hash:g.input_hash,graph_hash:sha(g.graph),review_hash:sha(g.review),locks_hash:v.locks_hash,payload_hash:sha(payload)};
  return {binding,payload,range:selection.request,selection_id:v.selection_id,warnings:compiled.warnings};
}

export async function assertRangeApproval(db:any,p:any,q:any){
  if(q.purpose!=='prompt_video')return;
  const input=inputSchema.parse(q.range_input);
  const expected=await rangeRequest(db,p,input);
  if(q.tasks.length!==1||q.tasks[0].endpoint!==guidedModel.t2v||sha(expected.binding)!==sha(q.scene_logic)||sha(q.tasks[0].payload)!==sha(expected.payload))
    throw Error('Prompt หรือผลตรวจฉากเปลี่ยนแล้ว กรุณาดูราคาใหม่');
}

export function guidedPrice(payload:any,rates:Rate[]){
  const rate=rates.find(r=>r.endpoint_id===guidedModel.t2v);
  const duration=Number(payload.duration),resolution=String(payload.resolution) as keyof typeof guidedModel.rates;
  // Published standard resolution rates resumed on Nov 16. The account API returns a generic per-second unit.
  if(!rate||rate.currency!=='USD'||rate.unit!=='seconds'||!Number.isFinite(rate.unit_price)||!(rate.unit_price>0&&rate.unit_price<=guidedModel.rates['480P'])||
     !(duration>0&&duration<=15)||!Object.hasOwn(guidedModel.rates,resolution))throw Error('ยืนยันราคาตามความละเอียดของ fal ไม่สำเร็จ');
  const perSecond=guidedModel.rates[resolution];
  return {rate,per_second:perSecond,estimate_usd:money(perSecond*duration),usd:money(perSecond*(Math.ceil(duration)+1))};
}

export function registerRangeVideo(app:any,db:any,ctx:any){
  const {P,guard,project,worker,fail,saveQuote,prices}=ctx;
  app.get(P+'/projects/:id/guided',guard,async(c:any)=>{try{
    const p=await project(c.req.param('id')),end=p.analysis?Math.min(15,p.analysis.source.end_s):null;
    const row=end?(await db.query(`SELECT s.id,s.request,s.evidence IS NOT NULL AS prepared,s.audio->>'status' AS audio_status,
      s.evidence->>'preview_asset_id' AS preview_asset_id
      FROM reverse_prompt_selections s WHERE s.project_id=$1 AND s.source_sha256=$2 AND (s.request->>'start_s')::numeric=0
      AND abs((s.request->>'end_s')::numeric-$3::numeric)<0.000001
      ORDER BY EXISTS (SELECT 1 FROM reverse_prompt_versions v WHERE v.selection_id=s.id) DESC,
      (s.request->>'sampling'='action_v2') DESC NULLS LAST,s.created_at DESC LIMIT 1`,[p.id,p.source_sha256,end])).rows[0]:null;
    const {base,remake}=row?await rangeVersions(db,p.id,row.id):{base:null,remake:null};
    const summary=(v:any)=>{
      if(!v)return null;
      const main=effectiveReplacements(v).main_character_id,location=v.document.shots[0]?.location_id;
      return {id:v.id,model:v.provenance?.model,main_character_id:main,location_id:location,
        character:v.document.characters.find((x:any)=>x.id===main)?.description||'',
        location:v.document.locations.find((x:any)=>x.id===location)?.description||'',
        character_edit:v.replacements.characters[main]||'',location_edit:v.replacements.locations[location]||'',
        has_dialogue_result:!!v.document.audio};
    };
    return c.json({connected:true,uploaded:!!p.source_asset_id,end_s:end,model:promptModel(),reasoning:'high',
      endpoint:guidedModel.t2v,selection:row||null,original:summary(base),remake:summary(remake)});
  }catch(e){return fail(c,e);}});
  app.get(P+'/projects/:id/prompt-video-price',guard,async(c:any)=>{try{
    const p=await project(c.req.param('id')),id=z.string().length(64).parse(c.req.query('version_id'));
    const v=(await db.query('SELECT * FROM reverse_prompt_versions WHERE id=$1 AND project_id=$2',[id,p.id])).rows[0];
    if(!v)throw Error('ไม่พบเวอร์ชัน prompt');
    const main=effectiveReplacements(v).main_character_id||undefined;
    const compiled=compileExport(v.document,v.replacements,guidedModel.t2v,p.analysis.source,undefined,main);
    if(compiled.blockers.length)throw Error(compiled.blockers.join(' · '));
    const price=guidedPrice(compiled.settings,await prices([guidedModel.t2v]));
    return c.json({...price,settings:compiled.settings,model:guidedModel.t2v,currency:'USD'});
  }catch(e){return fail(c,e);}});
  app.post(P+'/projects/:id/prompt-video-quote',guard,async(c:any)=>{try{
    const p=await project(c.req.param('id')),input=inputSchema.parse(await c.req.json()),w=await worker();
    if(!w.fal||!w.key_fingerprints?.fal||!w.guided_video)throw Error('ตัวผลิตวิดีโอยังไม่พร้อม');
    const request=await rangeRequest(db,p,input),endpoint=guidedModel.t2v;
    const task={slot:'prompt_video:'+request.selection_id,role:'prompt_video',provider:'fal',endpoint,model:endpoint,category:'video',selection_id:request.selection_id,
      payload:request.payload,range:request.range,...guidedPrice(request.payload,await prices([endpoint])),pricing_source:'https://fal.ai/models/'+endpoint};
    return c.json(await saveQuote(p,w,[task],'prompt_video','ส่งเฉพาะข้อความของ Prompt '+input.variant.toUpperCase()+' และค่าตั้งวิดีโอไปยัง fal', {
      scene_logic:request.binding,range_input:input,warnings:request.warnings,
      disclosure:{source:'ส่งเฉพาะ prompt และค่าตั้งวิดีโอไปยัง fal',pricing:'ประมาณการตามวินาทีและความละเอียด วงเงินเผื่อการปัดความยาวของผลลัพธ์หนึ่งวินาที',retention:'ขอให้ fal ปิดการเก็บ input/output ของคิว ผลงานจัดเก็บแยกในโปรเจกต์'}
    }));
  }catch(e){return fail(c,e);}});
  // Scope the catalog to project bindings provided by the authenticated Re:Video bridge.
  app.post(P+'/finished',guard,async(c:any)=>{try{
    const ids=z.object({projects:z.array(z.string().uuid()).max(200)}).strict().parse(await c.req.json()).projects;
    if(!ids.length)return c.json({items:[]});
    const result=await db.query(`SELECT id,project_id,role,shot_id,bytes,created_at,
      metadata->>'variant' AS variant,metadata->>'model' AS model,metadata->'range' AS range,
      metadata->>'duration_s' AS duration_s,metadata->>'version_id' AS version_id
      FROM reverse_assets WHERE project_id=ANY($1::uuid[]) AND
      (role='finished_video' OR (role IN ('generated_shot','final_video') AND metadata->'qa'->>'ok'='true'))
      ORDER BY created_at DESC,id DESC`,[ids]);
    const pending=(await db.query(`SELECT count(*)::int AS n FROM jobs WHERE kind='reverse'
      AND package->'reverse'->>'action'='prompt_video' AND package->'reverse'->>'project_id'=ANY($1::text[])
      AND status NOT IN ('READY_TO_POST','FAILED','CANCELLED')`,[ids])).rows[0].n;
    return c.json({items:result.rows,pending});
  }catch(e){return fail(c,e);}});
}
