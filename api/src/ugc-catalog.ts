import { rankSources, matchRank, type RankSources, type ArenaRow } from './ugc-ranked.js';
import type pg from 'pg';
import { isStoryModel, openAIModelLabel, readModels, type ModelSource } from './openai-models.js';
import { chooseGenerationSeconds } from './video-director.js';
import { type UgcFalIdentity, MissingEndpoint, PREVIOUS_FRAME, type FalVideoModel } from './video-registry.js';
import { ugcOpeningField, videoProvider } from './ugc-contract.js';

type Kind = 'video' | 'ideas';
type Rate = {resolution:string;unit:string;unit_usd:number;image_usd:number};
type Entry = {id:string;name:string;rates?:Rate[];resolutions?:string[];durations?:number[];checked_at?:string;source_url?:string;native_audio?:boolean;available?:boolean};
type Ranked=ArenaRow & {endpoint?:string;available:boolean;reason?:string;resolution?:string};
type SourceState<T>={rows:T[];checked_at:string|null;error?:string};
type Sources={arena:SourceState<ArenaRow>;featured:SourceState<string>;index:SourceState<UgcFalIdentity>};
type Snapshot = {models:Entry[];checked_at:string|null;stale:boolean;error?:string;ranked?:Ranked[];featured?:string[];sources?:Sources};
const empty = ():Snapshot => ({models:[],checked_at:null,stale:false});

export function videoEntry(m:FalVideoModel, provider:typeof videoProvider):Entry|null {
  if (m.verification_error) throw Error(m.verification_error);
  if (!m.available || !ugcOpeningField(m) || !m.audio || !m.billing || !m.price || m.price.currency!=='USD') return null;
  const unit = m.price.unit;
  if (!(m.billing.basis==='per_request' ? /^(requests?|videos?|generations?)$/i : /^seconds?$/i).test(unit)) return null;
  const rates:Rate[]=[];
  for(const resolution of m.resolutions.filter(r=>/^(360|480|720|1080)p$/i.test(r))){
    const tariff=m.billing.rates[resolution.toLowerCase()]??m.billing.rates['*'];
    if (!(Number.isFinite(tariff) && tariff>0)) continue;
    try {
      for(const seconds of [3,4]){
        const duration=chooseGenerationSeconds(m.durations,seconds);
        if(!duration || duration>30)throw Error('unsupported duration');
        provider.build(m,{prompt:'One presenter holds the product and speaks Thai to camera.',duration,resolution,
          audio:true,image_url:PREVIOUS_FRAME,aspect_ratio:'9:16'});
      }
    } catch { continue; }
    rates.push({resolution,unit,unit_usd:tariff,image_usd:m.billing.reference_image_usd??0});
  }
  return rates.length ? {id:m.endpoint_id,name:m.name,available:true,native_audio:true,durations:m.durations.filter(n=>n<=30),checked_at:m.checked_at,
    source_url:m.source_url,resolutions:rates.map(r=>r.resolution),rates} : null;
}

async function rankedSnapshot(previous:Snapshot,provider:typeof videoProvider,source:RankSources):Promise<Snapshot>{
  const now=new Date().toISOString(), failed=new Set<string>();
  async function refreshSource<T>(label:string,read:()=>Promise<T[]>,last?:SourceState<T>):Promise<SourceState<T>>{
    try{return {rows:await read(),checked_at:now};}
    catch{failed.add(label);return {rows:last?.rows??[],checked_at:last?.checked_at??null,error:'อัปเดต '+label+' ไม่สำเร็จ'};}
  }
  const [arena,featured,index]=await Promise.all([
    refreshSource('Arena',source.arena,previous.sources?.arena),
    refreshSource('fal.ai New and Noteworthy',source.featured,previous.sources?.featured),
    refreshSource('fal.ai catalog',source.index,previous.sources?.index),
  ]);
  const matched=arena.rows.map(r=>({...r,...matchRank(r,index.rows)}));
  const rankedEndpoints=new Set(matched.flatMap(m=>m.id?[m.id]:[]));
  const suggested=featured.rows.filter(id=>!rankedEndpoints.has(id)&&index.rows.some(m=>m.id===id&&m.category==='image-to-video'&&m.active));
  const ids=[...new Set([...matched.flatMap(r=>r.id&&!r.reason?[r.id]:[]),...suggested])];
  const lookup=source.schemas(ids);
  const verified=new Map<string,Entry>(), reasons=new Map<string,string>();
  let next=0;
  async function verify(){
    while(next<ids.length){
      const id=ids[next++];
      try{
        const model=await lookup(id);
        if(model.endpoint_id!==id)throw Error('identity');
        const entry=videoEntry(model,provider);
        if(entry)verified.set(id,entry);
        else reasons.set(id,model.reason||(!ugcOpeningField(model)?'schema ของ endpoint นี้ไม่รับรูปเป็นเฟรมเปิด':model.audio!==true?'ยังไม่รองรับเสียงพูดในช็อตเปิด':'schema ภาพเปิด ความละเอียด หรือราคายังใช้กับ UGC ไม่ได้'));
      }catch(e){
        if(e instanceof MissingEndpoint){reasons.set(id,'ไม่พบ endpoint สำหรับภาพเปิดใน catalog ล่าสุด');continue;}
        failed.add('fal.ai schema/ราคา');
        const old=previous.models.find(m=>m.id===id);
        if(old)verified.set(id,old);
        else reasons.set(id,'ยังตรวจ schema และราคากับ fal.ai ไม่สำเร็จ');
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(4,ids.length)},verify));
  const ranked=matched.map(({id,reason,...r})=>{
    const model=id?verified.get(id):undefined;
    const variantOK=!r.resolution||model?.resolutions?.some(x=>x.toLowerCase()===r.resolution);
    const why=reason||(id?reasons.get(id):undefined)||(model&&!variantOK?'endpoint ไม่รองรับ '+r.resolution+' ตามอันดับนี้':undefined);
    return {...r,endpoint:id,available:!!model&&!!variantOK&&!why,reason:!index.checked_at?'ยังตรวจ fal.ai catalog ไม่สำเร็จ':why};
  });
  const extra=suggested.filter(id=>verified.has(id));
  const allowed=new Set([...ranked.flatMap(r=>r.available&&r.endpoint?[r.endpoint]:[]),...extra]);
  const models=ids.filter(id=>allowed.has(id)).map(id=>verified.get(id)!);
  return {models,ranked,featured:extra,sources:{arena,featured,index},checked_at:failed.size?previous.checked_at:now,stale:!!failed.size,
    ...(failed.size?{error:'อัปเดตไม่สำเร็จ · '+[...failed].join(', ')}:{})};
}
export function publicCatalog(snapshot:Snapshot){
  const {sources,...catalog}=snapshot;
  return {...catalog,...(sources?{source_status:Object.fromEntries(Object.entries(sources).map(([key,s])=>[key,{checked_at:s.checked_at,error:s.error}]))}:{})};
}
export function ugcCatalog(pool:pg.Pool, provider:typeof videoProvider, brains?:ModelSource,
  sources:RankSources=rankSources){
  const pending=new Map<Kind,Promise<Snapshot>>();
  async function stored(kind:Kind, db:pg.Pool|pg.PoolClient=pool):Promise<Snapshot>{
    return (await db.query('SELECT data FROM integrations WHERE provider=$1',['ugc_catalog_'+kind])).rows[0]?.data??empty();
  }
  async function refresh(kind:Kind):Promise<Snapshot>{
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const lock=kind==='video'?7631041:7631042;
      if(!(await db.query('SELECT pg_try_advisory_xact_lock($1) AS ok',[lock])).rows[0].ok){
        await db.query('SELECT pg_advisory_xact_lock($1)',[lock]);
        const latest=await stored(kind,db);
        await db.query('COMMIT');
        return latest;
      }
      const previous=await stored(kind,db);
      let snapshot:Snapshot;
      const now=new Date().toISOString();
      if(kind==='ideas'){
        try{
          const index=await readModels(brains,true);
          if(index.source!=='openai'&&!(Array.isArray(brains)&&index.source==='configured'))throw Error();
          snapshot={models:index.ids.filter(isStoryModel).map(id=>({id,name:openAIModelLabel(id)})),checked_at:index.checked_at??now,stale:false};
        }catch{snapshot={...previous,stale:true,error:'ติดต่อ OpenAI เพื่ออัปเดตรายชื่อโมเดลไม่ได้'};}
      }else snapshot=await rankedSnapshot(previous,provider,sources);
      await db.query('INSERT INTO integrations(provider,data) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET data=excluded.data,updated_at=now()',
        ['ugc_catalog_'+kind,JSON.stringify(snapshot)]);
      await db.query('COMMIT');
      return snapshot;
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  return async(kind:Kind,force=false):Promise<Snapshot>=>{
    if(!force){
      const cached=await stored(kind);
      if((kind!=='video'||cached.ranked)&&(cached.checked_at||cached.models.length||cached.stale))return cached;
    }
    const existing=pending.get(kind);
    if(existing)return existing;
    const next=refresh(kind).finally(()=>pending.delete(kind));
    pending.set(kind,next);
    return next;
  };
}
