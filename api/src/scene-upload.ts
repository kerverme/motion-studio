/** Owner-supplied fal output, kept separate from source evidence. No provider call. */
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {sealUpload} from './reverse-storage.js';
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const InspectionUpload=z.object({graph_id:Hash,shot_id:z.string().regex(/^shot_[0-9]{3,5}$/),sha256:Hash,bytes:z.number().int().positive().max(64*1024*1024),content_type:z.enum(['video/mp4','video/webm','video/quicktime']),rights_confirmed:z.literal(true)}).strict();
export function registerSceneUpload(app:any,pool:any,ctx:any){
 const {P,guard,project,fail}=ctx,upload=ctx.upload||sealUpload;
 app.post(P+'/projects/:id/inspection-upload',guard,async(c:any)=>{try{
  const p=await project(c.req.param('id'));const h=c.req.header('x-inspection-metadata')||'';
  if(h.length>4096)throw Error('Inspection metadata too large');const input=InspectionUpload.parse(JSON.parse(h));
  const graph=(await pool.query('SELECT g.*,v.document FROM reverse_scene_graphs g JOIN reverse_prompt_versions v ON v.id=g.version_id AND v.project_id=g.project_id WHERE g.id=$1 AND g.project_id=$2',[input.graph_id,p.id])).rows[0];
  if(!graph||!graph.document.shots.some((s:any)=>s.id===input.shot_id))throw Error('Select a shot from this project’s scene graph');
  if(p.source_sha256===input.sha256||(await pool.query("SELECT id FROM reverse_assets WHERE project_id=$1 AND sha256=$2 AND role IN ('source','shot_clip','prompt_clip','prompt_clip_audio') LIMIT 1",[p.id,input.sha256])).rows.length)throw Error('Upload the generated result, not the original source or preview');
  const length=c.req.header('content-length');if(length&&Number(length)!==input.bytes)throw Error('Upload length differs from metadata');
  if(!c.req.raw.body)throw Error('Generated video body is required');
  const id=randomUUID(),sealed=await upload(Readable.fromWeb(c.req.raw.body),`reverse-private/${p.id}/${id}.sealed`,input.sha256,input.bytes);
  if(sealed.bytes!==input.bytes||sealed.sha256!==input.sha256)throw Error('Generated upload checksum or size mismatch');
  const metadata={graph_id:graph.id,version_id:graph.version_id,input_hash:graph.input_hash,rights_confirmed:true,inspection_only:true,origin:'owner_uploaded_unverified_provider',media_validated:false};
  await pool.query("INSERT INTO reverse_assets(id,project_id,shot_id,role,storage_key,sha256,bytes,content_type,encryption,metadata) VALUES($1,$2,$3,'generated_candidate',$4,$5,$6,$7,$8,$9)",[id,p.id,input.shot_id,sealed.storage_key,sealed.sha256,sealed.bytes,input.content_type,JSON.stringify(sealed.encryption),JSON.stringify(metadata)]);
  return c.json({asset_id:id,shot_id:input.shot_id,role:'generated_candidate',media_validated:false,next_step:'inspection-prepare',paid_requests:0},201);
 }catch(e){return fail(c,e);}});
}
