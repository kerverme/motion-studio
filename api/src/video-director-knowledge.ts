import {createHash} from 'node:crypto';
import {researchModelGuide} from './video-director-guides.js';

export type DirectorDB = {query:(sql:string, params?:any[])=>Promise<{rows:any[]}>};
export interface ResearchModel {
  endpoint_id:string; category:string; name:string; available:boolean; endpoint_available?:boolean; input_schema:Record<string,any>;
  schema_hash:string; checked_at:string; source_url:string;
}
type Chunk={tag:string;text:string;source:string};
export type Knowledge={
  endpoint_id:string;version:string;schema_hash:string;documents:Chunk[];
  documented:boolean;researched_at:string;
};
const TTL=24*60*60*1000;
const inFlight=new WeakMap<DirectorDB,Map<string,Promise<Knowledge>>>();
const signature=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clean=(v:string)=>v.replace(/\s+/g,' ').trim();
const fields=/prompt|shot|camera|audio|sound|voice|dialog|image|video_url|reference|duration|motion|physic|element|subject|identity|seed|limitation|timing/i;

function apiEvidence(model:ResearchModel):Chunk[]{
  const result:Chunk[]=[];
  for(const [tag,raw] of Object.entries(model.input_schema.properties||{})){
    if(!fields.test(tag)||!raw||typeof raw!=='object')continue;
    const field=raw as Record<string,any>;
    const text=[field.title,field.description,...(field.enum||[]).slice(0,30)].filter(x=>typeof x==='string').join('. ');
    if(text)result.push({tag,source:model.source_url,text:clean(text).slice(0,2000)});
    for(const example of (field.examples||[]).slice(0,2)){
      if(typeof example==='string'&&/prompt/.test(tag))result.push({tag:'example_'+tag,text:clean(example).slice(0,2000),source:model.source_url});
    }
  }
  return result;
}

// Only fetch this exact official host and path, without provider credentials or redirects.
export async function readFalDocumentation(model:ResearchModel):Promise<{url:string,text:string}|null>{
  if(!/^[a-z0-9_-]+(?:\/[a-z0-9_.-]+)+$/i.test(model.endpoint_id)||model.endpoint_id.split('/').some(p=>p==='.'||p==='..'))return null;
  const url='https://fal.ai/models/'+model.endpoint_id+'/llms.txt';
  let response:Response;
  try{response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(7000)});}catch{return null;}
  if(!response.ok||Number(response.headers.get('content-length')||0)>400000)return null;
  const data=await response.text();
  if(data.length>400000||!data.includes('https://fal.run/'+model.endpoint_id+'`'))return null;
  return {url,text:data};
}

export function buildKnowledge(model:ResearchModel,doc:{url:string;text:string}|null,now=new Date()):Knowledge{
  const documents=apiEvidence(model);
  if(doc){
    // Examples and input docs only. Usage snippets contain client code and unrelated boilerplate.
    const intro=doc.text.match(/^>\s*(.+)$/m)?.[1];
    if(intro)documents.push({tag:'description',source:doc.url,text:clean(intro).slice(0,1600)});
    const section=(doc.text.split(/### Output Schema|\*\*Required Parameters Example\*\*/)[0]||'');
    for(const entry of section.split(/\n- \*\*`/).slice(1)){
      const end=entry.indexOf('`**');if(end<1)continue;
      const tag=entry.slice(0,end);
      if(fields.test(tag))documents.push({tag,source:doc.url,text:clean(entry.slice(end+3)).slice(0,1800)});
    }
    // Capture exact-endpoint guidance sections, retaining each source locator and provenance.
    for(const m of doc.text.matchAll(/^#{2,4} (.*(?:Prompting|Guidance|Limitations|Tips|Best Practices)[^\n]*)\n([\s\S]*?)(?=^#{2,4} |$(?![\s\S]))/gmi)){
      documents.push({tag:'guide_'+clean(m[1]),source:doc.url,text:clean(m[2]).slice(0,3000)});
    }
  }
  const version=signature([2,model.endpoint_id,model.schema_hash,documents]);
  return {endpoint_id:model.endpoint_id,version,schema_hash:model.schema_hash,documents,documented:!!doc,researched_at:now.toISOString()};
}

type KnowledgeOptions={read?:typeof readFalDocumentation;now?:Date};
export function ensureVideoKnowledge(db:DirectorDB,model:ResearchModel,options:KnowledgeOptions={}):Promise<Knowledge>{
  let pending=inFlight.get(db);if(!pending){pending=new Map();inFlight.set(db,pending);}
  const key=JSON.stringify([model.endpoint_id,model.schema_hash]);
  const started=pending.get(key);if(started)return started;
  const task=(async()=>{
    const now=options.now||new Date();
    const row=(await db.query('SELECT profile,checked_at FROM video_prompt_knowledge WHERE endpoint_id=$1 AND schema_hash=$2 ORDER BY checked_at DESC LIMIT 1',[model.endpoint_id,model.schema_hash])).rows[0];
    if(row&&now.getTime()-new Date(row.checked_at).getTime()<(row.profile.documented?TTL:3600000))return row.profile as Knowledge;
    const doc=await (options.read||readFalDocumentation)(model);
    // Retain prior verified guidance if the official site is temporarily unavailable.
    if(!doc&&row?.profile.documented){
      // Check back in an hour; keep the prior evidence timestamp and version.
      await db.query("UPDATE video_prompt_knowledge SET checked_at=$3::timestamptz-interval '23 hours' WHERE endpoint_id=$1 AND version=$2",[model.endpoint_id,row.profile.version,now.toISOString()]);
      return row.profile as Knowledge;
    }
    const profile=buildKnowledge(model,doc,now);
    const result=await db.query(`INSERT INTO video_prompt_knowledge(endpoint_id,version,schema_hash,profile,researched_at,checked_at)
      VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(endpoint_id,version) DO UPDATE SET checked_at=GREATEST(video_prompt_knowledge.checked_at,excluded.checked_at) RETURNING profile`,
      [model.endpoint_id,profile.version,model.schema_hash,JSON.stringify(profile),now.toISOString()]);
    return result.rows[0].profile as Knowledge;
  })().finally(()=>pending!.delete(key));
  pending.set(key,task);return task;
}

export async function syncVideoKnowledge(db:DirectorDB,models:ResearchModel[]):Promise<void>{
  const items=[...new Map(models.filter(m=>(m.endpoint_available??m.available)&&m.schema_hash&&m.input_schema?.properties).map(m=>[m.endpoint_id,m])).values()];
  for(let i=0;i<items.length;i+=3){
    const results=await Promise.allSettled(items.slice(i,i+3).map(async m=>{const base=await ensureVideoKnowledge(db,m);await researchModelGuide(db,m,base);}));
    results.forEach((r,j)=>{if(r.status==='rejected')console.warn('Model documentation refresh failed',items[i+j].endpoint_id);});
  }
}

const tokens=(v:string)=>new Set(v.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]);
export function retrieveKnowledge(profile:Knowledge,query:string,limit=8):Chunk[]{
  const queryTerms=tokens(query);
  return profile.documents.map((doc,i)=>{
    const words=tokens(doc.tag.replaceAll('_',' ')+' '+doc.text);
    let score=/^prompt$|^example_prompt$/.test(doc.tag)?3:/^guide_/.test(doc.tag)?4:0;
    for(const term of queryTerms)if(words.has(term))score+=2;
    return {doc,i,score};
  }).filter(d=>d.score>0).sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,limit).map(d=>d.doc);
}
