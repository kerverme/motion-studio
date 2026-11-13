import {z} from 'zod';
import {createHash} from 'node:crypto';

export const REVERSE_SCHEMA='motion.reverse.production.v1';
export const sha=(x:unknown):string=>{
  const stable=(v:any):string=>v===null?'null':Array.isArray(v)?'['+v.map(stable).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
  return createHash('sha256').update(stable(x)).digest('hex');
};
const Hash=z.string().regex(/^[0-9a-f]{64}$/);
export const ShotId=z.string().regex(/^shot_[0-9]{3,5}$/);
const Finite=z.number().finite();
const Text=z.string().max(16000);
export const SourceInput=z.object({
  sha256:Hash, bytes:z.number().int().positive().max(512*1024*1024),
  filename:z.string().min(1).max(200), content_type:z.enum(['video/mp4','video/webm','video/quicktime','video/x-matroska']),
}).strict();
export const ProjectInput=z.object({origin_key:z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/),title:z.string().trim().min(1).max(300),source:SourceInput}).strict();
export const Evidence=z.object({kind:z.enum(['measured','model_estimated','user_edited','unknown']),
  asset_ids:z.array(z.string().uuid()).max(30).default([]),detail:Text.default('')}).strict();
export const Semantic=z.object({
  schema:z.literal('motion.reverse.shot.v1'), shot_id:ShotId,
  scene_description:Text, summary_th:Text,
  characters:z.array(z.object({ref:z.string().regex(/^C[1-9][0-9]?$/),label:z.string().max(200),description:Text,position:Text,
    registry_match:z.object({id:z.string().regex(/^char_[0-9]{3,5}$/),confidence:Finite.min(0).max(1),distinctive:z.boolean(),basis:Text}).strict().nullable().default(null)}).strict()).max(30),
  character_actions:z.array(z.object({t0:Finite.min(0),t1:Finite.min(0),text:Text,confidence:Finite.min(0).max(1)}).strict()).max(100),
  location:z.object({label:z.string().max(200),description:Text,registry_match:z.string().regex(/^loc_[0-9]{3,5}$/).nullable().default(null)}).strict(),
  objects:z.array(z.object({label:z.string().max(200),description:Text,position:Text}).strict()).max(40),
  starting_state:Text,ending_state:Text,
  camera:z.object({framing:Text,angle:Text,motion:Text}).strict(), lighting:Text,visual_style:Text,
  transition_in:Text,transition_out:Text,
  audio:z.object({heard:z.boolean(),description:Text,dialogue:z.array(z.object({t0:Finite.min(0),t1:Finite.min(0),speaker:z.string().max(200),text:Text}).strict()).max(60)}).strict(),
  production_method:z.object({label:z.enum(['live_action','ai_generated','3d_animation','2d_animation','motion_graphics','screen_recording','mixed','unknown']),basis:Text}).strict(),
  uncertainty:z.array(Text).max(100), reverse_prompt:Text,
}).strict();
export type SemanticT=z.infer<typeof Semantic>;
export function validateSemantic(raw:unknown,shot:any):SemanticT{
  const s=Semantic.parse(raw);if(s.shot_id!==shot.id)throw Error('Vision response belongs to another shot');
  if(!s.scene_description.trim()||!s.reverse_prompt.trim()||/\[MOCK\]|mock[- ]simulated|placeholder/i.test(s.reverse_prompt))throw Error('Missing real scene description/reverse prompt');
  for(const a of [...s.character_actions,...s.audio.dialogue])if(a.t1<a.t0||a.t1>shot.clip_duration_s+.05)throw Error('Model event is outside the approved clip');
  return s;
}

export const Reference=z.object({asset_id:z.string().uuid(),role:z.enum(['first_frame','last_frame','identity']),
  rights_confirmed:z.literal(true),allow_source_reference:z.boolean().default(false)}).strict();
export const AudioTask=z.object({
  id:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),role:z.enum(['narration','dialogue','sfx','music']),
  text:z.string().min(1).max(2000),voice_id:z.string().max(200).optional(),model:z.string().min(1).max(150),
  start_s:Finite.min(0),duration_s:Finite.positive().max(60),gain:Finite.min(0).max(1).default(.6),
}).strict();
const GraphicLayer=z.object({kind:z.enum(['text','rect','circle','line','counter','bar']),
  text:z.string().max(500).default(''),x:Finite.min(0).max(1),y:Finite.min(0).max(1),
  width:Finite.min(0).max(1).default(.5),height:Finite.min(0).max(1).default(.1),
  color:z.string().regex(/^#[0-9a-fA-F]{6}$/),size:Finite.positive().max(150).default(45),
  from:Finite.default(0),to:Finite.default(1),enter:Finite.min(0).max(1).default(0),exit:Finite.min(0).max(1).default(1),
  motion:z.enum(['none','fade','slide_left','slide_up','grow']).default('fade')}).strict();
export const ShotPlan=z.object({
  shot_id:ShotId,prompt:z.string().min(1).max(60000),method:z.enum(['code','generative','hybrid']),
  model:z.string().min(1).max(250),settings:z.record(z.unknown()).default({}),references:z.array(Reference).max(4).default([]),
  characters:z.record(z.object({description:Text,keep_source:z.boolean().default(false),rights_confirmed:z.boolean().default(false)}).strict()).default({}),
  location:z.object({description:Text,keep_source:z.boolean().default(false),rights_confirmed:z.boolean().default(false)}).strict().nullable().default(null),
  graphic:z.object({background:z.string().regex(/^#[0-9a-fA-F]{6}$/),layers:z.array(GraphicLayer).min(1).max(40)}).strict().optional(),
  audio:z.array(AudioTask).max(40).default([]),
  subtitle_mode:z.enum(['none','generated_alignment']).default('none'),
  continuity_group:z.string().max(100).default(''),handoff_previous_frame:z.boolean().default(false),
  qa_criteria:z.array(z.string().min(1).max(1000)).min(1).max(30),
  human_reviewed:z.boolean().default(false),
}).strict();
export type ShotPlanT=z.infer<typeof ShotPlan>;
export const ProductionPlan=z.object({schema:z.literal(REVERSE_SCHEMA),project_id:z.string().uuid(),
  source_sha256:Hash,analysis_sha256:Hash,base_revision:z.string().max(100).nullable(),origin:z.enum(['user','planner','repair','initial']),
  delivery_promise:z.enum(['reference_remake','motion_led','code_motion','hybrid']),
  recipe_id:z.string().uuid().nullable().default(null),shots:z.array(ShotPlan).min(1).max(200),
  uncertainty:z.array(Text).max(100).default([]),
}).strict();
export type ProductionPlanT=z.infer<typeof ProductionPlan>;
export function validatePlan(raw:unknown,project:any):ProductionPlanT{
  const p=ProductionPlan.parse(raw);
  if(p.project_id!==project.id||p.source_sha256!==project.source_sha256)throw Error('Plan/source binding mismatch');
  if(p.analysis_sha256!==sha(project.analysis))throw Error('Source analysis changed; inspect a new plan');
  const measured=new Map<string,any>((project.analysis?.shots||[]).map((s:any)=>[s.id,s]));
  const seen=new Set();
  for(const s of p.shots){
    if(!measured.has(s.shot_id)||seen.has(s.shot_id))throw Error('Unknown or repeated shot');seen.add(s.shot_id);
    if(s.method!=='generative'&&!s.graphic)throw Error('Code/hybrid shots require explicit graphics; no placeholder renderer');
    if(s.method==='code'&&s.references.length)throw Error('Code route cannot silently include provider references');
    const shot=measured.get(s.shot_id);
    if(s.audio.some(a=>a.start_s+a.duration_s>shot.duration_s+.05))throw Error('Audio task extends beyond measured shot');
    for(const c of Object.values(s.characters))if(c.keep_source&&!c.rights_confirmed)throw Error('Keeping a source character requires explicit rights');
    if(s.location?.keep_source&&!s.location.rights_confirmed)throw Error('Keeping source location requires explicit rights');
  }
  return p;
}

export function defaultMethod(semantic:any):'code'|'generative'{
  return ['motion_graphics','screen_recording'].includes(semantic?.production_method?.label)?'code':'generative';
}
export function revision(plan:ProductionPlanT){return sha(plan);}
export const Approval=z.object({quote_id:z.string().uuid(),binding:Hash,accepted_usd:Finite.min(0).max(1000),
  source_confirmed:z.literal(true),rights_confirmed:z.literal(true),approval_origin:z.enum(['motion_owner_ui','revideo_owner_ui','chat_owner']).default('motion_owner_ui')}).strict();
export function assertApproval(quote:any,input:z.infer<typeof Approval>,project:any,now=Date.now()){
  if(quote.binding!==input.binding||quote.total_usd!==input.accepted_usd)throw Error('Approval amount or request changed');
  if(Date.parse(quote.expires_at)<=now)throw Error('Quote expired; inspect a new quote');
  if(quote.revision!==(project.current_revision||'none')&&quote.purpose!=='vision')throw Error('Project changed after quote');
  if(quote.analysis_sha256!==sha(project.analysis))throw Error('Source analysis changed after quote');
  if(quote.source_sha256!==project.source_sha256||quote.blockers?.length)throw Error('Quote is blocked or source changed');
  if(quote.tasks.some((t:any)=>!Number.isFinite(t.usd)||t.usd<0))throw Error('Unknown price cannot be approved');
}
