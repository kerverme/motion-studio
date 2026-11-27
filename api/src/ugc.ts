import { randomUUID } from 'node:crypto';
import type { Context,Hono,Next } from 'hono';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import { DEFAULT_OPENAI_MODEL, readModels, type ModelSource } from './openai-models.js';
import { openaiResponse, OpenAIReadUnavailable } from './openai-response.js';
import { digest } from './text-video-contract.js';
import { registryIssue } from './video-registry.js';
import {
  Document, Evidence, Suggestion, blank, falEndpoints, makeQuote, quoteBinding, reuseKey, uuid, validateDocument, validateClaims,
  videoItem,videoProvider,type DraftDocument,type Media,type VoiceOffer,
} from './ugc-contract.js';
import { readMedia, saveMedia,type AssetStore } from './ugc-media.js';
import { notionProducts } from './ugc-notion.js';

type Guard=(c:Context,next:Next)=>Promise<any>;
type Options={guard:Guard;workerGuard:Guard;storage:AssetStore|null;models?:ModelSource;
  video?:typeof videoProvider;response?:typeof openaiResponse;env?:NodeJS.ProcessEnv;notionFetch?:typeof fetch};

const P='/app/api/ugc';
const finished=['READY_TO_POST','FAILED','CANCELLED'];
const isFal=(endpoint:string)=>(falEndpoints as readonly string[]).includes(endpoint);
const json=(x:unknown)=>JSON.stringify(x);
const documentError=(e:unknown)=>e instanceof ZodError
  ? e.issues.slice(0,3).map(i=>i.path.join('.')+' · '+i.message).join(' / ')
  : e instanceof Error?e.message:'ทำรายการไม่สำเร็จ';

export function registerUgc(app:Hono,pool:pg.Pool,options:Options) {
  const env=options.env||process.env, g=options.guard, store=options.storage;
  const provider=options.video||videoProvider, respond=options.response||openaiResponse;
  const notion=notionProducts(pool,store,options.notionFetch,env);
  const get=async(id:string,conn:pg.Pool|pg.PoolClient=pool,lock=false)=>
    (await conn.query('SELECT * FROM ugc_drafts WHERE id=$1'+(lock?' FOR UPDATE':''),[uuid.parse(id)])).rows[0];
  const mediaFor=async(id:string):Promise<Media[]>=>
    (await pool.query('SELECT id,kind,content_type,storage_key FROM ugc_media WHERE draft_id=$1 ORDER BY created_at,id',[id])).rows;
  const callsFor=async(id:string|null):Promise<any[]>=>!id?[]:
    (await pool.query('SELECT DISTINCT ON (slot) * FROM text_video_calls WHERE job_id=$1 ORDER BY slot,created_at DESC',[id])).rows;
  const worker=async():Promise<any>=>{
    const row=(await pool.query("SELECT data,updated_at FROM integrations WHERE provider='text_video_worker'")).rows[0];
    return row && Date.now()-Date.parse(row.updated_at)<120000 && row.data.ugc_version===1 ? row.data : null;
  };
  const model=async (endpoint:string)=>{
    if (!isFal(endpoint)) throw Error('เลือกโมเดล fal.ai สำหรับฉากที่สร้างจากภาพ');
    try {return await provider.model(endpoint,'image-to-video');}
    catch(e){throw Error(registryIssue(e));}
  };
  const transactional=async<T>(fn:(conn:pg.PoolClient)=>Promise<T>)=>{
    const conn=await pool.connect();
    try {await conn.query('BEGIN');const result=await fn(conn);await conn.query('COMMIT');return result;}
    catch(e){await conn.query('ROLLBACK');throw e;}
    finally{conn.release();}
  };
  const shape=(row:any)=>({id:row.id,revision:row.revision,document:row.document,evidence:row.evidence,quote:row.quote,
    job_id:row.job_id,source_job_id:row.source_job_id,regenerate_scene:row.regenerate_scene,approval_id:row.approval?.id,
    planning:row.planning?{state:row.planning.state,error:row.planning.error}:null});
  const requireDraft=(r:any)=>{if(!r) throw Error('ไม่พบร่าง UGC');return r;};
  const availableVoice=(w:any):w is VoiceOffer=>!!w?.eleven&&!!w.voice_id&&['eleven_v3','eleven_v4'].includes(w.voice_model)
    &&Number.isFinite(w.voice_usd_per_1000_characters)&&w.voice_usd_per_1000_characters>0
    && (Date.now()/1000-w.capabilities_checked_at)<3900;

  async function price(row:any) {
    const d=Document.parse(row.document), media=await mediaFor(row.id);
    validateDocument(d,media,row.evidence);
    if (!store) throw Error('ยังไม่ได้ตั้งค่าที่เก็บไฟล์ Studio');
    if (['queued','submitting','accepted'].includes(row.planning?.state)) throw Error('รอให้สมองวางฉากเสร็จก่อนขอราคา');
    const baseId=row.job_id||row.source_job_id;
    const [base,calls,w]=await Promise.all([
      baseId?pool.query('SELECT status,package,removed_at,locked_until>now() AS locked FROM jobs WHERE id=$1',[baseId]).then(r=>r.rows[0]):null,
      callsFor(baseId),worker(),
    ]);
    if (!w) throw Error('motion-worker ที่รองรับ UGC AI ยังไม่พร้อม');
    if (row.job_id && (base?.status!=='FAILED'||base.locked||base.removed_at)) throw Error('งานเดิมยังไม่สามารถเปิดตรวจราคาซ่อมได้');
    if (calls.some(c=>['submitting','unknown'].includes(c.status)) || !row.job_id&&calls.some(c=>c.status==='accepted'))
      throw Error('ยังไม่ทราบผลคำขอเดิม กรุณาตรวจรายการผู้ให้บริการก่อน ระบบจะไม่สร้างซ้ำ');
    const old=base?.package?.text_video?.approval;
    const regenerate=row.job_id?null:row.regenerate_scene;
    const canReuse=(item:any)=>old && calls.some(c=>c.slot===item.slot && (c.status==='done'||row.job_id&&c.status==='accepted'))
      && [...old.fal,...old.eleven].some(x=>x.slot===item.slot&&reuseKey(x)===reuseKey(item));
    const cached=(shot:any)=>old?.fal.find((x:any)=>x.scene_id===shot.id&&x.endpoint_id===d.endpoint&&x.resolution===d.resolution&&
      x.media_id===shot.media_id&&x.edited_seconds===shot.seconds&&x.visual===shot.visual&&x.camera===shot.camera);
    const newFal=d.scenes.filter(s=>s.mode==='fal' && !(cached(s)&&canReuse(cached(s))&&s.id!==regenerate));
    if (newFal.length&&(!env.FAL_KEY||!w.fal)) throw Error('ยังไม่ได้ตั้ง FAL_KEY บน API และ motion-worker');
    const route=newFal.length?await model(d.endpoint):null;
    const fal=await Promise.all(d.scenes.filter(s=>s.mode==='fal').map(async s=>{
      const item=cached(s);
      if (item&&canReuse(item)&&s.id!==regenerate) return item;
      return {...await videoItem(route!,s,d.resolution,provider),visual:s.visual,camera:s.camera};
    }));
    const isKept=(item:any)=>canReuse(item)&&!(item.slot==='fal:'+regenerate);
    let offer:VoiceOffer;
    // A text-only edit can use the exact previous voice and cost record.
    const narrationMatches=old && d.scenes.every((s,i)=>old.eleven.some((v:any)=>v.slot==='eleven:'+s.id&&
      v.text===(i? s.narration:d.hook)&&canReuse(v)));
    if (narrationMatches) offer={voice_id:old.voice_id,voice_model:old.voice_model,
      voice_usd_per_1000_characters:old.eleven[0].usd_per_1000_characters,
      audio_pricing_source:old.voice_pricing_source,capabilities_checked_at:Date.parse(old.voice_checked_at)/1000,fal:!!w.fal};
    else if (availableVoice(w)) offer=w;
    else throw Error('ยังตรวจเรตเสียง ElevenLabs ปัจจุบันไม่ได้');
    const initial=makeQuote(row.revision,d,media,fal,offer,[]);
    const reused=[...fal,...initial.eleven].filter(isKept).map(x=>x.slot);
    // Reusing one job never changes the request identity of an already submitted slot.
    if (row.job_id && [...fal,...initial.eleven].some(item=> {
      const prior=[...old.fal,...old.eleven].find(x=>x.slot===item.slot);
      return prior && reuseKey(prior)!==reuseKey(item) && calls.some(c=>c.slot===item.slot);
    })) throw Error('ผู้ให้บริการเปลี่ยนเงื่อนไขคำขอเดิม กรุณาเปิดฉบับแก้ไขและขอราคาใหม่');
    const q=makeQuote(row.revision,d,media,fal,offer,reused);
    const credits=q.eleven.filter(item=>q.pending_slots.includes(item.slot)).reduce((n,x)=>n+x.credits,0);
    if (credits>Number(env.MOTION_MAX_CREDITS_PER_EPISODE||6000)) throw Error('ค่าเสียงเกินเพดานเครดิตของ Studio');
    return {q,credits};
  }

  app.get(P+'/config',g,async c=>{
    const [brains,w,mapping]=await Promise.all([readModels(options.models),worker(),notion.config()]);
    return c.json({brains:brains.ids,default_brain:DEFAULT_OPENAI_MODEL,openai:!!env.OPENAI_API_KEY,
      fal:!!env.FAL_KEY,storage:!!store,worker:!!w,notion:{enabled:notion.enabled,databases:notion.allowed,mapping}});
  });
  let catalog: {expires:number;promise:Promise<any[]>}|undefined;
  app.get(P+'/models',g,async c=>{
    if (!catalog||catalog.expires<Date.now()) {
      catalog={expires:Date.now()+60_000,promise:Promise.all(falEndpoints.map(async endpoint=>{
        try {
          const m=await model(endpoint);
          return {id:endpoint,name:m.name,resolutions:m.resolutions,durations:m.durations.filter(x=>x<=30),available:m.available,reason:m.reason};
        } catch(e){return {id:endpoint,name:endpoint,available:false,reason:documentError(e)};}
      }))};
    }
    return c.json({models:await catalog.promise});
  });
  app.get(P+'/drafts',g,async c=>c.json({drafts:(await pool.query(`SELECT d.id,d.document->'product'->>'name' AS name,
    d.updated_at,j.status AS job_status FROM ugc_drafts d LEFT JOIN jobs j ON j.id=d.job_id ORDER BY d.updated_at DESC LIMIT 50`)).rows}));
  app.post(P+'/drafts',g,async c=>{
    try {
      const id=uuid.parse(c.req.header('idempotency-key'));
      const b=z.object({name:z.string().trim().max(140).optional(),evidence:z.array(Evidence).max(6).default([])}).strict().parse(await c.req.json());
      await pool.query('INSERT INTO ugc_drafts(id,document,evidence) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,json(blank(b.name)),json(b.evidence)]);
      return c.json(shape(await get(id)),201);
    } catch(e){return c.json({error:documentError(e)},422);}
  });
  app.get(P+'/drafts/:id',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      const [media,history]=await Promise.all([mediaFor(row.id),pool.query(`SELECT id,status,created_at,package->'ugc'->'export' AS export
        FROM jobs WHERE package ? 'ugc' AND package->'ugc'->>'draft_id'=$1 ORDER BY created_at DESC LIMIT 25`,[row.id])]);
      return c.json({...shape(row),media:await Promise.all(media.map(async ({storage_key,...m})=>({...m,url:await store?.sign(storage_key)}))),
        history:history.rows});
    } catch(e){return c.json({error:documentError(e)},404);}
  });
  app.patch(P+'/drafts/:id',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id'));
      const raw=z.object({revision:uuid,document:Document}).strict().parse(await c.req.json());
      const row=requireDraft(await get(id));
      if (row.job_id||['queued','submitting','accepted'].includes(row.planning?.state)) throw Error('รอให้งานปัจจุบันจบก่อนแก้บท');
      if (row.revision!==raw.revision) throw Error('ฉบับร่างเปลี่ยนแล้ว เปิดฉบับล่าสุด');
      if (digest(row.document)===digest(raw.document)) return c.json(shape(row));
      const r=await pool.query(`UPDATE ugc_drafts SET document=$2,revision=gen_random_uuid(),quote=NULL,planning=NULL,updated_at=now()
        WHERE id=$1 AND revision=$3 AND job_id IS NULL AND (planning IS NULL OR planning->>'state' IN ('done','failed')) RETURNING *`,
        [id,json(raw.document),raw.revision]);
      return r.rows[0]?c.json(shape(r.rows[0])):c.json({error:'ร่างเปลี่ยนแล้ว เปิดฉบับล่าสุด'},409);
    } catch(e){return c.json({error:documentError(e)},422);}
  });

  app.post(P+'/drafts/:id/media',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      if (!store||row.job_id) throw Error('ยังอัปโหลดสื่อในร่างนี้ไม่ได้');
      return c.json(await saveMedia(pool,store,row.id,await readMedia(c.req.raw.body,c.req.header('content-length'))),201);
    } catch(e){return c.json({error:documentError(e)},422);}
  });
  app.get(P+'/notion/columns/:id',g,async c=>{
    try{return c.json({columns:await notion.columns(uuid.parse(c.req.param('id')))});}
    catch(e){return c.json({error:documentError(e)},422);}
  });
  app.put(P+'/notion/config',g,async c=>{
    try{return c.json(await notion.save(await c.req.json()));}
    catch(e){return c.json({error:documentError(e)},422);}
  });
  app.get(P+'/notion/products',g,async c=>{
    try{return c.json(await notion.list(c.req.query('cursor')));}
    catch(e){return c.json({error:documentError(e)},422);}
  });
  app.post(P+'/drafts/:id/import-notion',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      if (row.job_id) throw Error('เปิดฉบับแก้ไขก่อนนำเข้าสินค้า');
      const b=z.object({page_id:uuid}).strict().parse(await c.req.json());
      return c.json(await notion.imported(row.id,b.page_id));
    } catch(e){return c.json({error:documentError(e)},422);}
  });

  app.post(P+'/drafts/:id/suggest',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id')), nonce=uuid.parse(c.req.header('idempotency-key'));
      const b=z.object({revision:uuid}).strict().parse(await c.req.json());
      const row=requireDraft(await get(id));
      if (row.planning?.nonce===nonce) return c.json(shape(row));
      if (!env.OPENAI_API_KEY) throw Error('ยังไม่ได้ตั้งค่า OpenAI');
      const d=Document.parse(row.document);
      if (!d.product.name || !(await readModels(options.models)).ids.includes(d.model)) throw Error('กรอกชื่อสินค้าและเลือกสมอง OpenAI');
      const r=await pool.query(`UPDATE ugc_drafts SET planning=$2,quote=NULL,updated_at=now()
        WHERE id=$1 AND revision=$3 AND job_id IS NULL AND (planning IS NULL OR planning->>'state' IN ('done','failed')) RETURNING *`,
        [id,json({state:'queued',nonce}),b.revision]);
      if (!r.rows[0]) throw Error('มีคำขอวางฉากอยู่แล้วหรือร่างเปลี่ยน');
      void pump().catch(()=>{});
      return c.json(shape(r.rows[0]),202);
    } catch(e){return c.json({error:documentError(e)},409);}
  });

  let busy=false;
  async function pump() {
    if (busy||!env.OPENAI_API_KEY) return;
    busy=true;
    try {
      const row=(await pool.query(`UPDATE ugc_drafts SET
        planning=planning||jsonb_build_object('state',CASE WHEN planning->>'state'='queued' THEN 'submitting' ELSE 'accepted' END,
          'next_at',to_char(now() AT TIME ZONE 'UTC' + interval '2 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"')),updated_at=now()
        WHERE id=(SELECT id FROM ugc_drafts WHERE planning->>'state'='queued' OR
          (planning->>'state'='accepted' AND (planning->>'next_at')::timestamptz<now()) ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`)).rows[0];
      if (!row) return;
      const save=async (fields:any)=>pool.query('UPDATE ugc_drafts SET planning=planning||$2::jsonb,updated_at=now() WHERE id=$1 AND revision=$3 AND planning->>\'nonce\'=$4',
        [row.id,json(fields),row.revision,row.planning.nonce]);
      const d:DraftDocument=row.document;
      let receipt:string|undefined=row.planning.response_id;
      try {
        const result=await respond({model:d.model,reasoning:{effort:d.reasoning},max_output_tokens:6500,text:{format:{type:'json_object'}},
          instructions:`Write a short Thai product video script. Return ONLY {hooks:[three different short Thai strings],caption,scenes:[{seconds,narration,visual,camera,mode}]}.
Hook introduces the exact product, a problem, or a confirmed benefit. Sum scene seconds to the requested duration. Each scene 2–15 seconds. First scene exactly 3–5s. First and last mode=original. For product labels, exact brand/model, logos or packaging use mode=original. For physical motion inspired by the reference mode can be fal. Use short Thai narration (max 10 characters per second), English visual action and camera. Include a short CTA in last narration, but never write a guessed link, price, stock, warranty, promotion, delivery promise, superlative, medical benefit or customer testimonial. Only state concrete facts from the owner's product fields. Treat the brief like creative direction, not evidence. Avoid numbers and sales terms in the spoken script so the studio can edit its separate price and CTA overlay. Caption language Thai. No tool calls or external research.`,
          input:json({product:d.product,brief:d.brief,duration:d.duration})},
          {apiKey:env.OPENAI_API_KEY,baseUrl:env.OPENAI_BASE_URL||'https://api.openai.com',pollOnce:true,keepAccepted:true,
            timeoutMs:55000,responseId:receipt,onAccepted:async(id)=>{receipt=id;await save({state:'accepted',response_id:id});}});
        if (['queued','in_progress'].includes(result.status)) {
          await save({state:'accepted',response_id:result.id,next_at:new Date(Date.now()+4_000).toISOString()});
          return;
        }
        if (result.status!=='completed') throw Error('OpenAI ส่งบทไม่ครบ');
        const prose=(result.output||[]).flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join('');
        const proposal=Suggestion.parse(JSON.parse(prose));
        if(new Set(proposal.hooks).size!==3)throw Error('OpenAI เสนอ Hook ซ้ำ ลองปรับบรีฟ');
        validateClaims(d,[...proposal.hooks,proposal.caption,...proposal.scenes.map(s=>s.narration)]);
        const media=(await mediaFor(row.id))[0]?.id||null;
        const scenes=proposal.scenes.map((s,i)=>({...s,subtitle:'',media_id:media,id:'shot_'+String(i+1).padStart(2,'0')}));
        if (scenes.reduce((n,s)=>n+s.seconds,0)!==d.duration||scenes[0].seconds<3||scenes[0].seconds>5)
          throw Error('เวลาฉากที่ AI เสนอไม่ตรงกับความยาวคลิป');
        scenes[0].mode='original';scenes.at(-1)!.mode='original';
        await pool.query(`UPDATE ugc_drafts SET document=$2,planning=$3,revision=gen_random_uuid(),quote=NULL,updated_at=now()
          WHERE id=$1 AND revision=$4 AND planning->>'nonce'=$5`,
          [row.id,json({...d,...proposal,hook:proposal.hooks[0],scenes}),json({state:'done',nonce:row.planning.nonce}),row.revision,row.planning.nonce]);
      } catch(e) {
        if (e instanceof OpenAIReadUnavailable && receipt)
          await save({state:'accepted',response_id:receipt,next_at:new Date(Date.now()+30_000).toISOString()});
        else await save({state:'failed',error:documentError(e).slice(0,350)});
      }
    } finally {busy=false;}
  }
  function start() {
    setInterval(()=>{
      void pool.query(`UPDATE ugc_drafts SET planning=planning||'{"state":"failed","error":"ไม่ได้รับรหัส OpenAI ของคำขอเดิม ระบบหยุดก่อนส่งซ้ำ"}'::jsonb
        WHERE planning->>'state'='submitting' AND (planning->>'next_at')::timestamptz<now()`).then(pump).catch(()=>{});
    },5000).unref();
  }

  app.post(P+'/drafts/:id/quote',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      const b=z.object({revision:uuid,product_confirmed:z.literal(true)}).strict().parse(await c.req.json());
      if (b.revision!==row.revision) throw Error('ร่างเปลี่ยนแล้ว กรุณาตรวจใหม่');
      const {q}=await price(row);
      const r=await pool.query(`UPDATE ugc_drafts SET quote=$2 WHERE id=$1 AND revision=$3 AND approval IS NOT DISTINCT FROM $4::jsonb
        AND (planning IS NULL OR planning->>'state' IN ('done','failed')) RETURNING id`,[row.id,json(q),row.revision,row.approval?json(row.approval):null]);
      if (!r.rows[0]) throw Error('ร่างหรือการอนุมัติเปลี่ยนระหว่างตรวจราคา');
      return c.json(q);
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.post(P+'/drafts/:id/produce',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      const b=z.object({revision:uuid,quote_id:uuid,approved:z.literal(true)}).strict().parse(await c.req.json());
      const prior=async(conn:pg.Pool|pg.PoolClient)=>(await conn.query('SELECT job_id FROM ugc_approvals WHERE id=$1 AND draft_id=$2 AND revision=$3',[b.quote_id,row.id,b.revision])).rows[0];
      const approved=await prior(pool);
      if (approved) return c.json({job_id:approved.job_id,duplicate:true});
      const q=row.quote;
      if (!q||q.id!==b.quote_id||q.revision!==b.revision||q.document_hash!==digest(row.document)||!(Date.parse(q.expires_at)>Date.now()))
        throw Error('ตรวจร่างและยืนยันราคาฉบับล่าสุดก่อนผลิต');
      let live;
      try {live=await price(row);}
      catch(e){const duplicate=await prior(pool);if(duplicate)return c.json({job_id:duplicate.job_id,duplicate:true});throw e;}
      if (quoteBinding(q)!==quoteBinding(live.q)) {
        await pool.query('UPDATE ugc_drafts SET quote=NULL WHERE id=$1 AND quote->>\'id\'=$2 AND approval IS NOT DISTINCT FROM $3::jsonb',
          [row.id,q.id,row.approval?json(row.approval):null]);
        throw Error('ราคา โมเดล หรือฉากเปลี่ยน กรุณาคิดราคาและยืนยันอีกครั้ง');
      }
      const result=await transactional(async tx=>{
        const current=requireDraft(await get(row.id,tx,true));
        const duplicate=await prior(tx);
        if (duplicate) return {job_id:duplicate.job_id,duplicate:true};
        if (current.revision!==b.revision||current.quote?.id!==q.id||current.job_id!==row.job_id||current.approval?.id!==row.approval?.id||
            ['queued','submitting','accepted'].includes(current.planning?.state)||!(Date.parse(q.expires_at)>Date.now()))
          throw Error('ร่างหรือใบราคาถูกแก้ไข กรุณาตรวจใหม่');
        const approval={...q,approved_at:new Date().toISOString(),valid_until:new Date(Date.now()+8*3600000).toISOString(),
          payload_hash:digest({fal:q.fal,eleven:q.eleven})};
        const d:DraftDocument=current.document;
        const spec={version:2,plan_id:row.id,input:q.input,plan:q.plan,approval};
        const pkg={title_th:d.product.name,generation_model:d.model,video_model:d.endpoint,voice:{voice_id:q.voice_id,model_id:q.voice_model},
          text_video:spec,ugc:{draft_id:row.id,media:q.media,export:{caption:d.caption,order_url:d.product.order_url,cta:d.cta,
            price:d.show_price?d.product.price:'',promo:d.show_promo?d.product.promo:''}}};
        let id=row.job_id;
        if (id) {
          const job=(await tx.query('SELECT status,locked_until>now() AS locked,removed_at FROM jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
          if (job?.status!=='FAILED'||job.locked||job.removed_at) throw Error('งานเดิมยังไม่พร้อมให้ลองใหม่');
          await tx.query(`UPDATE jobs SET status='NEW',error=NULL,attempts=0,locked_by=NULL,locked_until=NULL,finished_at=NULL,
            package=$2,budget_credits=ceil(used_credits)+$3,updated_at=now() WHERE id=$1`,[id,json(pkg),live.credits]);
        } else {
          id=(await tx.query("INSERT INTO jobs(kind,status,package,budget_credits) VALUES('text_video','NEW',$1,$2) RETURNING id",[json(pkg),live.credits])).rows[0].id;
          if (q.reused.length) await tx.query(`INSERT INTO text_video_calls(job_id,slot,approval_id,provider,input_hash,status,request_id,data)
            SELECT $1,slot,$2,provider,input_hash,status,request_id,data FROM
            (SELECT DISTINCT ON(slot) * FROM text_video_calls WHERE job_id=$3 ORDER BY slot,created_at DESC) last
            WHERE status='done' AND slot=ANY($4::text[])`,[id,q.id,current.source_job_id,q.reused]);
        }
        await tx.query('INSERT INTO ugc_approvals(id,draft_id,revision,job_id,approval) VALUES($1,$2,$3,$4,$5)',[q.id,row.id,row.revision,id,json(approval)]);
        await tx.query('UPDATE ugc_drafts SET approval=$2,job_id=$3,updated_at=now() WHERE id=$1',[row.id,json(approval),id]);
        return {job_id:id,duplicate:false};
      });
      return c.json(result,result.duplicate?200:202);
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.post(P+'/drafts/:id/edit',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id'));
      const b=z.object({job_id:uuid,scene:z.string().regex(/^shot_\d{2}$/).optional()}).strict().parse(await c.req.json());
      const result=await transactional(async tx=>{
        const row=requireDraft(await get(id,tx,true));
        if (!row.job_id && row.source_job_id===b.job_id && (row.regenerate_scene||null)===(b.scene||null)) return row;
        if (row.job_id!==b.job_id) throw Error('เปิดงานฉบับล่าสุดก่อนแก้ไข');
        const last=(await tx.query("SELECT status,package,locked_until>now() AS locked FROM jobs WHERE id=$1 FOR UPDATE",[b.job_id])).rows[0];
        const calls=await tx.query("SELECT DISTINCT ON(slot) status FROM text_video_calls WHERE job_id=$1 ORDER BY slot,created_at DESC",[b.job_id]);
        if (!finished.includes(last?.status)||last.locked||calls.rows.some(x=>['submitting','unknown','accepted'].includes(x.status)))
          throw Error('ตรวจคำขอที่ยังไม่ทราบผลให้เสร็จก่อนแก้ฉบับนี้');
        if (b.scene&&!row.document.scenes.some((s:any)=>s.id===b.scene&&s.mode==='fal')) throw Error('เลือกฉาก fal ที่ต้องการสร้างใหม่');
        return (await tx.query(`UPDATE ugc_drafts SET revision=gen_random_uuid(),job_id=NULL,source_job_id=$2,regenerate_scene=$3,
          quote=NULL,approval=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[id,b.job_id,b.scene||null])).rows[0];
      });
      return c.json(shape(result));
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.get(P+'/jobs/:id',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id'));
      const j=(await pool.query("SELECT status,progress,error,package,result FROM jobs WHERE id=$1 AND package ? 'ugc'",[id])).rows[0];
      if (!j) return c.json({error:'ไม่พบงาน'},404);
      const calls=await callsFor(id);
      const events=(await pool.query("SELECT message,data FROM job_events WHERE job_id=$1 AND data ? 'scene_id' ORDER BY id DESC LIMIT 40",[id])).rows;
      return c.json({id,status:j.status,progress:j.progress,error:j.error,notes:j.package.ugc.export,
        scenes:j.package.text_video.plan.shots.map((s:any)=>({id:s.id,mode:s.mode,
          state:events.find(e=>e.data.scene_id===s.id)?.data?.state||null,
          video:calls.find(x=>x.slot==='fal:'+s.id)?.status||null,voice:calls.find(x=>x.slot==='eleven:'+s.id)?.status||null})),
        video:j.result?.final_key?await store?.sign(j.result.final_key):null,
        download:j.result?.final_key?await store?.sign(j.result.final_key,true):null});
    } catch(e){return c.json({error:documentError(e)},404);}
  });
  app.post('/internal/ugc/check-dispatch',options.workerGuard,async c=>{
    try {
      const b=z.object({job_id:uuid,approval_id:uuid,slot:z.string().regex(/^(fal|eleven):shot_\d{2}$/)}).strict().parse(await c.req.json());
      const r=(await pool.query(`SELECT a.approval,j.status,j.package FROM ugc_approvals a JOIN jobs j ON j.id=a.job_id
        JOIN ugc_drafts d ON d.job_id=j.id AND d.id=a.draft_id WHERE a.id=$1 AND j.id=$2 AND d.approval->>'id'=$1::text AND j.removed_at IS NULL`,
        [b.approval_id,b.job_id])).rows[0];
      const a=r?.approval, w=await worker();
      if(!a||!w||!['GENERATING_AUDIO','RENDERING'].includes(r.status)||!r.package.ugc||digest(r.package.text_video.approval)!==digest(a)||
        !a.approved_at||!(Date.parse(a.valid_until)>Date.now())||!a.pending_slots.includes(b.slot)) throw Error('คำอนุมัติหมดอายุหรือไม่ตรงกับฉาก');
      if (b.slot.startsWith('fal:')) {
        const approved=a.fal.find((x:any)=>x.slot===b.slot);
        if (!approved||!w.fal) throw Error('ไม่พบค่าใช้จ่าย fal ที่ยืนยัน');
        const m=await model(approved.endpoint_id);
        const current=await provider.price(m,approved.payload);
        if(m.schema_hash!==approved.schema_hash||current.usd!==approved.estimated_usd||current.unit!==approved.billing_unit||
          current.quantity!==approved.billing_quantity||m.price?.unit_price!==approved.account_unit_usd) throw Error('ราคา fal.ai เปลี่ยน ต้องขอราคาใหม่');
      } else {
        const item=a.eleven.find((x:any)=>x.slot===b.slot);
        if (!item||!availableVoice(w)||w.voice_id!==item.voice_id||w.voice_model!==item.model_id||
          w.voice_usd_per_1000_characters!==item.usd_per_1000_characters) throw Error('ราคาเสียงเปลี่ยน ต้องขอราคาใหม่');
      }
      return c.json({ok:true,approval_id:b.approval_id,slot:b.slot});
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  return {start,pump};
}
