import type pg from 'pg';
import { isStoryModel, openAIModelLabel, readModels, type ModelSource } from './openai-models.js';
import { chooseGenerationSeconds } from './video-director.js';
import { discoverUgcEndpoints, MissingEndpoint, PREVIOUS_FRAME, type FalVideoModel } from './video-registry.js';
import { creatorVideoModels, videoProvider } from './ugc-contract.js';

type Kind = 'video' | 'ideas';
type Rate = {resolution:string;unit:string;unit_usd:number;image_usd:number};
type Entry = {id:string;name:string;rates?:Rate[];resolutions?:string[];durations?:number[];checked_at?:string;source_url?:string;native_audio?:boolean;available?:boolean};
type Snapshot = {models:Entry[];checked_at:string|null;stale:boolean;error?:string};
const empty = ():Snapshot => ({models:[],checked_at:null,stale:false});

function videoEntry(m:FalVideoModel, provider:typeof videoProvider):Entry|null {
  if (m.verification_error) throw Error(m.verification_error);
  if (!m.available || m.category!=='image-to-video' || !m.audio || !m.billing || !m.price || m.price.currency!=='USD') return null;
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

export function ugcCatalog(pool:pg.Pool, provider:typeof videoProvider, brains?:ModelSource,
  discover:(seed:string[])=>ReturnType<typeof discoverUgcEndpoints>=discoverUgcEndpoints){
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
      }else{
        const models:Entry[]=[], failed:string[]=[];
        const seed=[...new Set([...creatorVideoModels,...previous.models.map(m=>m.id)])];
        let catalog;
        try{catalog=await discover(seed);}
        catch{failed.push('catalog');catalog={ids:seed,load:(id:string)=>provider.model(id,'image-to-video')};}
        const entries=await Promise.all(catalog.ids.map(async id=>{
          try{return videoEntry(await catalog.load(id),provider);}
          catch(error){
            if(error instanceof MissingEndpoint)return null;
            failed.push(id);
            return previous.models.find(m=>m.id===id)??null;
          }
        }));
        models.push(...entries.filter((m):m is Entry=>!!m));
        snapshot={models,checked_at:failed.length?previous.checked_at:new Date().toISOString(),stale:!!failed.length,
          ...(failed.length?{error:'ยังอัปเดตข้อมูล fal.ai ไม่ครบ · '+failed.join(', ')}:{})};
      }
      await db.query('INSERT INTO integrations(provider,data) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET data=excluded.data,updated_at=now()',
        ['ugc_catalog_'+kind,JSON.stringify(snapshot)]);
      await db.query('COMMIT');
      return snapshot;
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  return async(kind:Kind,force=false):Promise<Snapshot>=>{
    if(!force){
      const cached=await stored(kind);
      if(cached.checked_at||cached.models.length||cached.stale)return cached;
    }
    const existing=pending.get(kind);
    if(existing)return existing;
    const next=refresh(kind).finally(()=>pending.delete(kind));
    pending.set(kind,next);
    return next;
  };
}
