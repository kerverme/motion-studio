import { randomUUID } from 'node:crypto';
import type { Context,Hono,Next } from 'hono';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import { DEFAULT_OPENAI_MODEL, readModels, type ModelSource } from './openai-models.js';
import { openaiResponse, OpenAIReadUnavailable } from './openai-response.js';
import { digest } from './text-video-contract.js';
import { estimateUgcImage, registryIssue, UGC_IMAGE_MODELS } from './video-registry.js';
import {
  Document, Evidence, Suggestion, CreatorSuggestion, approvedOpening, blank, creatorVideoModels, falEndpoints, isProduct, reviewerBasis, reviewerSources, speakerShot, makeQuote, quoteBinding, reuseKey, uuid, validateDocument, validateClaims,
  videoItem,videoProvider,type DraftDocument,type Media,type VoiceOffer,
} from './ugc-contract.js';
import { readMedia, saveMedia,type AssetStore } from './ugc-media.js';
import { notionProducts } from './ugc-notion.js';

type Guard=(c:Context,next:Next)=>Promise<any>;
type Options={guard:Guard;workerGuard:Guard;storage:Pick<AssetStore,'sign'>|null;references:AssetStore|null;models?:ModelSource;
  video?:typeof videoProvider;image?:typeof estimateUgcImage;response?:typeof openaiResponse;env?:NodeJS.ProcessEnv;notionFetch?:typeof fetch};

const P='/app/api/ugc';
const finished=['READY_TO_POST','FAILED','CANCELLED'];
const isFal=(endpoint:string)=>(falEndpoints as readonly string[]).includes(endpoint);
const json=(x:unknown)=>JSON.stringify(x);
const documentError=(e:unknown)=>e instanceof ZodError
  ? e.issues.slice(0,3).map(i=>i.path.join('.')+' · '+i.message).join(' / ')
  : e instanceof Error?e.message:'ทำรายการไม่สำเร็จ';

export function registerUgc(app:Hono,pool:pg.Pool,options:Options) {
  const env=options.env||process.env, g=options.guard, store=options.storage, references=options.references;
  const imagePrice=options.image||estimateUgcImage;
  const provider=options.video||videoProvider, respond=options.response||openaiResponse;
  const notion=notionProducts(pool,references,options.notionFetch,env);
  const get=async(id:string,conn:pg.Pool|pg.PoolClient=pool,lock=false)=>
    (await conn.query('SELECT * FROM ugc_drafts WHERE id=$1'+(lock?' FOR UPDATE':''),[uuid.parse(id)])).rows[0];
  const mediaFor=async(id:string):Promise<Media[]>=>
    (await pool.query('SELECT id,kind,content_type,storage_key,role,details FROM ugc_media WHERE draft_id=$1 ORDER BY created_at,id',[id])).rows;
  const callsFor=async(id:string|null):Promise<any[]>=>!id?[]:
    (await pool.query('SELECT DISTINCT ON (slot) * FROM text_video_calls WHERE job_id=$1 ORDER BY slot,created_at DESC',[id])).rows;
  const worker=async():Promise<any>=>{
    const row=(await pool.query("SELECT data,updated_at FROM integrations WHERE provider='text_video_worker'")).rows[0];
    return row && Date.now()-Date.parse(row.updated_at)<120000 && [2,3].includes(row.data.ugc_version) && row.data.ugc_r2 ? row.data : null;
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
    image_quote:row.image_quote,image_job_id:row.image_job_id,
    planning:row.planning?{state:row.planning.state,error:row.planning.error}:null});
  const requireDraft=(r:any)=>{if(!r) throw Error('ไม่พบร่าง UGC');return r;};
  const availableVoice=(w:any):w is VoiceOffer=>!!w?.eleven&&!!w.voice_id&&['eleven_v3','eleven_v4'].includes(w.voice_model)
    &&Number.isFinite(w.voice_usd_per_1000_characters)&&w.voice_usd_per_1000_characters>0
    && (Date.now()/1000-w.capabilities_checked_at)<3900;

  async function price(row:any) {
    const d=Document.parse(row.document), media=await mediaFor(row.id);
    if(!d.reviewer&&!row.job_id&&!row.source_job_id)throw Error('เลือกคนรีวิวและตรวจเฟรมเปิดก่อนผลิต');
    validateDocument(d,media,row.evidence);
    if (!store||!references) throw Error('ตั้งค่าที่เก็บไฟล์ Studio และ R2 สำหรับภาพสินค้า');
    if (['queued','submitting','accepted'].includes(row.planning?.state)) throw Error('รอให้สมองวางฉากเสร็จก่อนขอราคา');
    const baseId=row.job_id||row.source_job_id;
    const [base,calls,w]=await Promise.all([
      baseId?pool.query('SELECT status,package,removed_at,locked_until>now() AS locked FROM jobs WHERE id=$1',[baseId]).then(r=>r.rows[0]):null,
      callsFor(baseId),worker(),
    ]);
    if (!w || (d.reviewer && w.ugc_version!==3)) throw Error('motion-worker ที่รองรับ UGC AI ยังไม่พร้อม');
    if (row.job_id && (base?.status!=='FAILED'||base.locked||base.removed_at)) throw Error('งานเดิมยังไม่สามารถเปิดตรวจราคาซ่อมได้');
    if (calls.some(c=>['submitting','unknown'].includes(c.status)) || !row.job_id&&calls.some(c=>c.status==='accepted'))
      throw Error('ยังไม่ทราบผลคำขอเดิม กรุณาตรวจรายการผู้ให้บริการก่อน ระบบจะไม่สร้างซ้ำ');
    const old=base?.package?.text_video?.approval;
    const regenerate=row.job_id?null:row.regenerate_scene;
    const canReuse=(item:any)=>old && calls.some(c=>c.slot===item.slot && (c.status==='done'||row.job_id&&c.status==='accepted'))
      && [...old.fal,...old.eleven].some(x=>x.slot===item.slot&&reuseKey(x)===reuseKey(item));
    const cached=(shot:any)=>old?.fal.find((x:any)=>x.scene_id===shot.id&&x.endpoint_id===d.endpoint&&x.resolution===d.resolution&&
      x.media_id===shot.media_id&&x.native_audio===speakerShot(d,d.scenes.indexOf(shot))&&
      (!x.native_audio||x.narration===shot.narration)&&x.edited_seconds===shot.seconds&&x.visual===shot.visual&&x.camera===shot.camera);
    const newFal=d.scenes.filter(s=>s.mode==='fal' && !(cached(s)&&canReuse(cached(s))&&s.id!==regenerate));
    if (newFal.length&&(!env.FAL_KEY||!w.fal)) throw Error('ยังไม่ได้ตั้ง FAL_KEY บน API และ motion-worker');
    const route=newFal.length?await model(d.endpoint):null;
    const fal=await Promise.all(d.scenes.filter(s=>s.mode==='fal').map(async s=>{
      const item=cached(s);
      if (item&&canReuse(item)&&s.id!==regenerate) return item;
      const speaking=speakerShot(d,d.scenes.indexOf(s));
      return {...await videoItem(route!,s,d.resolution,provider,speaking),visual:s.visual,camera:s.camera,...(speaking?{narration:s.narration}:{})};
    }));
    const isKept=(item:any)=>canReuse(item)&&!(item.slot==='fal:'+regenerate);
    let offer:VoiceOffer;
    // A text-only edit can use the exact previous voice and cost record.
    const narrationMatches=old && d.scenes.every((s,i)=>speakerShot(d,i)||old.eleven.some((v:any)=>v.slot==='eleven:'+s.id&&
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
      image_models:UGC_IMAGE_MODELS,creator_video_models:creatorVideoModels,
      fal:!!env.FAL_KEY,storage:!!references,worker:!!w,notion:{enabled:notion.enabled,databases:notion.allowed,mapping}});
  });
  let catalog: {expires:number;promise:Promise<any[]>}|undefined;
  app.get(P+'/models',g,async c=>{
    if (!catalog||catalog.expires<Date.now()) {
      catalog={expires:Date.now()+60_000,promise:Promise.all(falEndpoints.map(async endpoint=>{
        try {
          const m=await model(endpoint);
          const rates = m.available && m.billing && m.price ? m.resolutions.flatMap(resolution=>{
            const tariff=m.billing!.rates[resolution.toLowerCase()]??m.billing!.rates['*'];
            if (!tariff) return [];
            return [{resolution,unit:m.price!.unit,unit_usd:Math.max(tariff,m.price!.unit_price),
              image_usd:m.billing!.reference_image_usd||0}];
          }) : [];
          return {id:endpoint,name:m.name,resolutions:rates.map(r=>r.resolution),durations:m.durations.filter(x=>x<=30),
            available:m.available,native_audio:m.audio===true,reason:m.reason,rates,checked_at:m.checked_at,output_padding_seconds:m.output_padding_seconds,
            source_url:m.source_url};
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
      const [media,history,image]=await Promise.all([mediaFor(row.id),pool.query(`SELECT id,status,created_at,package->'ugc'->'export' AS export
        FROM jobs WHERE package ? 'ugc' AND NOT (package->'ugc' ?| array['image','frame']) AND package->'ugc'->>'draft_id'=$1 ORDER BY created_at DESC LIMIT 25`,[row.id]),
        row.image_job_id?pool.query("SELECT id,status,error,result,package->'ugc' ? 'frame' AS is_frame FROM jobs WHERE id=$1",[row.image_job_id]).then(r=>r.rows[0]):null]);
      const basis=row.document.reviewer?reviewerBasis(row.document):null;
      return c.json({...shape(row),media:await Promise.all(media.map(async ({storage_key,...m})=>({...m,
        matches_reviewer:m.role==='opening'&&m.details?.basis===basis,
        url:await (storage_key.startsWith('ugc-r2/')?references:store)?.sign(storage_key)}))),
        history:history.rows,image_job:image});
    } catch(e){return c.json({error:documentError(e)},404);}
  });
  app.patch(P+'/drafts/:id',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id'));
      const raw=z.object({revision:uuid,document:Document}).strict().parse(await c.req.json());
      const row=requireDraft(await get(id));
      if (row.job_id||['queued','submitting','accepted'].includes(row.planning?.state)) throw Error('รอให้งานปัจจุบันจบก่อนแก้บท');
      if (row.document.reviewer&&!raw.document.reviewer)throw Error('ร่างนี้ต้องใช้ขั้นตอนเลือกคนรีวิว');
      if (row.revision!==raw.revision) throw Error('ฉบับร่างเปลี่ยนแล้ว เปิดฉบับล่าสุด');
      if (digest(row.document)===digest(raw.document)) return c.json(shape(row));
      const r=await pool.query(`UPDATE ugc_drafts SET document=$2,revision=gen_random_uuid(),quote=NULL,image_quote=NULL,planning=NULL,updated_at=now()
        WHERE id=$1 AND revision=$3 AND job_id IS NULL AND (planning IS NULL OR planning->>'state' IN ('done','failed')) RETURNING *`,
        [id,json(raw.document),raw.revision]);
      return r.rows[0]?c.json(shape(r.rows[0])):c.json({error:'ร่างเปลี่ยนแล้ว เปิดฉบับล่าสุด'},409);
    } catch(e){return c.json({error:documentError(e)},422);}
  });

  app.post(P+'/drafts/:id/media',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      if (row.job_id) throw Error('เปิดฉบับแก้ไขก่อนอัปโหลดสื่อ');
      if (!references) throw Error('ยังไม่ได้ตั้งค่าที่เก็บสื่อสินค้า R2');
      const role=z.enum(['product','presenter']).parse(c.req.query('role')||'product');
      return c.json(await saveMedia(pool,references,row.id,await readMedia(c.req.raw.body,c.req.header('content-length')),role),201);
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

  async function prepareImage(row:any) {
    const d=Document.parse(row.document), r=d.reviewer;
    if(!d.product.name||!r||!['portrait','ai'].includes(r.kind)) throw Error('เลือกรูปคนรีวิวหรือพิธีกร AI และกรอกชื่อสินค้า');
    const {product,source}=reviewerSources(d,await mediaFor(row.id));
    const w=await worker();
    if(!references||!env.FAL_KEY||w?.ugc_version!==3||!w.fal)throw Error('งานเตรียมภาพ UGC ต้องใช้ R2 และ motion-worker รุ่นที่รองรับ fal.ai');
    const prompt='Create one natural 9:16 phone-video first frame of an adult presenter facing the camera, holding the exact product in image 1 beside their face. Show the entire face, both hands with natural fingers and the entire front of the product. Match the real size, colors, shape, exact model and packaging artwork in image 1. Use window light and a simple lived-in background. Keep a little space around the subject. No new logos, overlays, captions or prices. Product: '+JSON.stringify(d.product.name+' '+d.product.variant)+
      (r.kind==='portrait'?' Preserve the face, identity and clothes in image 2.':' Cast an original, fictional adult Thai presenter.');
    const item={...await imagePrice(r.image_endpoint,prompt,r.kind==='portrait'),slot:'fal:opening_image'};
    const media=r.kind==='portrait'?[product,source!]:[product];
    return {item,media,basis:reviewerBasis(d)};
  }
  const imageBinding=(data:{item:Awaited<ReturnType<typeof prepareImage>>['item'];media:Media[];basis:string})=>{
    const {pricing_checked_at,...item}=data.item;
    return digest({item,media:data.media,basis:data.basis});
  };
  const activeOpeningJob=async(tx:pg.PoolClient,id:string)=>{
    const old=(await tx.query(`SELECT status,package, EXISTS(SELECT 1 FROM text_video_calls c WHERE c.job_id=j.id
      AND c.status IN ('submitting','unknown','accepted')) AS unresolved FROM jobs j WHERE id=$1`,[id])).rows[0];
    return old && (!finished.includes(old.status)||old.unresolved) ? old : null;
  };
  app.post(P+'/drafts/:id/extract-frame',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id'));
      const b=z.object({revision:uuid,seconds:z.number().finite().min(0).max(180)}).strict().parse(await c.req.json());
      const w=await worker();
      if(!references||w?.ugc_version!==3)throw Error('motion-worker สำหรับตัดเฟรมยังไม่พร้อม');
      const job_id=await transactional(async tx=>{
        const row=requireDraft(await get(id,tx,true));
        const d=Document.parse(row.document);
        if(row.job_id||row.revision!==b.revision||d.reviewer?.kind!=='clip')throw Error('เปิดร่างและคลิปคนรีวิวฉบับล่าสุดก่อนตัดเฟรม');
        const {source}=reviewerSources(d,await mediaFor(id));
        if(row.image_job_id){
          const current=await activeOpeningJob(tx,row.image_job_id);
          if(current){
            const frame=current.package?.ugc?.frame;
            if(frame?.source?.id===source!.id&&frame.seconds===b.seconds)return row.image_job_id;
            throw Error('รอให้การเตรียมเฟรมครั้งก่อนเสร็จก่อน');
          }
        }
        const pkg={title_th:d.product.name,ugc:{draft_id:id,frame:{media_id:randomUUID(),source,seconds:b.seconds}}};
        const job=(await tx.query("INSERT INTO jobs(kind,status,package,budget_credits) VALUES('text_video','NEW',$1,0) RETURNING id",[json(pkg)])).rows[0].id;
        await tx.query('UPDATE ugc_drafts SET image_job_id=$2,updated_at=now() WHERE id=$1',[id,job]);
        return job;
      });
      return c.json({job_id},202);
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.post(P+'/drafts/:id/image-quote',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      const b=z.object({revision:uuid}).strict().parse(await c.req.json());
      if(row.job_id||row.revision!==b.revision)throw Error('เปิดร่างล่าสุดก่อนเตรียมภาพ');
      const data=await prepareImage(row);
      const quote={...data,media:undefined,binding:imageBinding(data),id:randomUUID(),revision:row.revision,
        expires_at:new Date(Date.now()+10*60_000).toISOString()};
      const updated=await pool.query('UPDATE ugc_drafts SET image_quote=$2 WHERE id=$1 AND revision=$3 AND job_id IS NULL RETURNING id',
        [row.id,json(quote),row.revision]);
      if(!updated.rowCount)throw Error('ร่างเปลี่ยนระหว่างตรวจราคา');
      return c.json(quote);
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.post(P+'/drafts/:id/produce-image',g,async c=>{
    try {
      const row=requireDraft(await get(c.req.param('id')));
      const b=z.object({revision:uuid,quote_id:uuid,approved:z.literal(true)}).strict().parse(await c.req.json());
      const prior=async(conn:pg.Pool|pg.PoolClient)=>(await conn.query('SELECT job_id FROM ugc_approvals WHERE id=$1 AND draft_id=$2 AND revision=$3',[b.quote_id,row.id,b.revision])).rows[0];
      const duplicate=await prior(pool);
      if(duplicate)return c.json({job_id:duplicate.job_id,duplicate:true});
      const q=row.image_quote;
      if(row.job_id||!q||q.id!==b.quote_id||row.revision!==b.revision||Date.parse(q.expires_at)<=Date.now())
        throw Error('ตรวจและยืนยันราคาภาพล่าสุด');
      const live=await prepareImage(row);
      if(q.binding!==imageBinding(live)) {
        await pool.query("UPDATE ugc_drafts SET image_quote=NULL WHERE id=$1 AND image_quote->>'id'=$2",[row.id,q.id]);
        throw Error('ราคาหรือภาพอ้างอิงเปลี่ยน กรุณาขอราคาใหม่');
      }
      const result=await transactional(async tx=>{
        const current=requireDraft(await get(row.id,tx,true));
        const found=await prior(tx);
        if(found)return {job_id:found.job_id,duplicate:true};
        if(current.job_id||current.revision!==b.revision||current.image_quote?.id!==q.id||Date.parse(q.expires_at)<=Date.now())
          throw Error('ร่างหรือใบราคาภาพเปลี่ยน');
        if(current.image_job_id && await activeOpeningJob(tx,current.image_job_id))
          throw Error('ตรวจสถานะคำขอภาพเดิมก่อนสร้างใหม่');
        const {item,media,basis}=live;
        const input={ugc:true,opening_image:true},plan={shots:[{id:'opening_image'}]};
        const approval={id:q.id,media,basis,fal:[item],eleven:[],pending_slots:[item.slot],approved_at:new Date().toISOString(),
          valid_until:new Date(Date.now()+8*3600000).toISOString(),plan_hash:digest({input,plan}),payload_hash:digest({fal:[item],eleven:[]})};
        const pkg={title_th:row.document.product.name,ugc:{draft_id:row.id,image:{basis,media_id:randomUUID()}},
          text_video:{version:2,input,plan,approval}};
        const id=(await tx.query("INSERT INTO jobs(kind,status,package,budget_credits) VALUES('text_video','NEW',$1,0) RETURNING id",[json(pkg)])).rows[0].id;
        await tx.query('INSERT INTO ugc_approvals(id,draft_id,revision,job_id,approval) VALUES($1,$2,$3,$4,$5)',[q.id,row.id,row.revision,id,json(approval)]);
        await tx.query('UPDATE ugc_drafts SET image_job_id=$2,updated_at=now() WHERE id=$1',[row.id,id]);
        return {job_id:id,duplicate:false};
      });
      return c.json(result,result.duplicate?200:202);
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.post(P+'/drafts/:id/suggest',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id')), nonce=uuid.parse(c.req.header('idempotency-key'));
      const b=z.object({revision:uuid}).strict().parse(await c.req.json());
      const row=requireDraft(await get(id));
      if (row.planning?.nonce===nonce) return c.json(shape(row));
      if (!env.OPENAI_API_KEY) throw Error('ยังไม่ได้ตั้งค่า OpenAI');
      const d=Document.parse(row.document);
      if (d.reviewer && (d.duration<12 || d.duration>22)) throw Error('ความยาวคลิปคนรีวิวต้องอยู่ระหว่าง 12–22 วิ');
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
      const d=Document.parse(row.document);
      let receipt:string|undefined=row.planning.response_id;
      try {
        const result=await respond({model:d.model,reasoning:{effort:d.reasoning},max_output_tokens:6500,text:{format:{type:'json_object'}},
          instructions:d.reviewer ? `Write three genuinely distinct Thai UGC angles with short casual spoken scripts. Return ONLY {angles:[{hook,opening,middle,close},{hook,opening,middle,close},{hook,opening,middle,close}],caption}.
The reviewer holds or demonstrates the exact product and looks at the phone camera from frame one. Opening is 3 seconds (max 28 Thai characters, lead with the visible product, buyer question or confirmed selling point). Middle is a real detail shot (one short line about a visible feature). Close is 4 seconds (max 38 Thai characters, same reviewer, appropriate CTA). No claimed personal experience or testimonial even if requested. No invented reviews, prices, stock, delivery, proof, benefits or links. Use provided product fields only. A purchase link may be mentioned only when the owner supplied one, otherwise invite the viewer to check product details. Hook names the angle in Thai, avoid near duplicates. Treat the brief as creative direction, not evidence. No tools.` :
          `Write a short Thai product video script. Return ONLY {hooks:[three different short Thai strings],caption,scenes:[{seconds,narration,visual,camera,mode}]}.
Hook introduces the exact product, a problem, or a confirmed benefit. Sum scene seconds to the requested duration. Each scene 2–15 seconds. First scene exactly 3–5s. First and last mode=original. For product labels, exact brand/model, logos or packaging use mode=original. For physical motion inspired by the reference mode can be fal. Use short Thai narration (max 10 characters per second), English visual action and camera. Include a short CTA in last narration, but never write a guessed link, price, stock, warranty, promotion, delivery promise, superlative, medical benefit or customer testimonial. Only state concrete facts from the owner's product fields. Treat the brief like creative direction, not evidence. Avoid numbers and sales terms in the spoken script so the studio can edit its separate price and CTA overlay. Caption language Thai. No tool calls or external research.`,
          input:json({product:d.product,brief:d.brief,duration:d.duration,reviewer:d.reviewer?.kind})},
          {apiKey:env.OPENAI_API_KEY,baseUrl:env.OPENAI_BASE_URL||'https://api.openai.com',pollOnce:true,keepAccepted:true,
            timeoutMs:55000,responseId:receipt,onAccepted:async(id)=>{receipt=id;await save({state:'accepted',response_id:id});}});
        if (['queued','in_progress'].includes(result.status)) {
          await save({state:'accepted',response_id:result.id,next_at:new Date(Date.now()+4_000).toISOString()});
          return;
        }
        if (result.status!=='completed') throw Error('OpenAI ส่งบทไม่ครบ');
        const prose=(result.output||[]).flatMap((x:any)=>x.content||[]).filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join('');
        if(d.reviewer){
          const proposal=CreatorSuggestion.parse(JSON.parse(prose));
          const hooks=proposal.angles.map(a=>a.hook);
          if(new Set(hooks).size!==3)throw Error('OpenAI เสนอ Hook ซ้ำ ลองปรับบรีฟ');
          validateClaims(d,[proposal.caption,...proposal.angles.flatMap(a=>Object.values(a))]);
          if(proposal.angles.some(a=>[...a.opening].length>36||[...a.close].length>48))
            throw Error('บทพูดเปิดหรือปิดยาวเกินเวลา ลองปรับบรีฟให้สั้นลง');
          await pool.query(`UPDATE ugc_drafts SET document=$2,planning=$3,revision=gen_random_uuid(),quote=NULL,image_quote=NULL,updated_at=now()
            WHERE id=$1 AND revision=$4 AND planning->>'nonce'=$5`,
            [row.id,json({...d,...proposal,hooks,hook:'',scenes:[]}),json({state:'done',nonce:row.planning.nonce}),row.revision,row.planning.nonce]);
          return;
        }
        const proposal=Suggestion.parse(JSON.parse(prose));
        if(new Set(proposal.hooks).size!==3)throw Error('OpenAI เสนอ Hook ซ้ำ ลองปรับบรีฟ');
        validateClaims(d,[...proposal.hooks,proposal.caption,...proposal.scenes.map(s=>s.narration)]);
        const media=(await mediaFor(row.id)).find(isProduct)?.id||null;
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
        if (b.scene&&!row.document.scenes.some((s:any)=>s.id===b.scene&&(row.document.reviewer||s.mode==='fal'))) throw Error('เลือกฉากที่ต้องการแก้');
        return (await tx.query(`UPDATE ugc_drafts SET revision=gen_random_uuid(),job_id=NULL,source_job_id=$2,regenerate_scene=$3,
          quote=NULL,approval=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[id,b.job_id,b.scene||null])).rows[0];
      });
      return c.json(shape(result));
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.put(P+'/jobs/:id/review',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id'));
      const check=z.enum(['ผ่าน','ต้องแก้','']);
      const b=z.object({scene:z.string().regex(/^shot_\d{2}$/),checks:z.object({presenter:check,product:check,thai:check,
        lip_sync:check,captions:check,cta:check}).strict(),note:z.string().trim().max(450)}).strict().parse(await c.req.json());
      const job=(await pool.query("SELECT status,package FROM jobs WHERE id=$1 AND package ? 'ugc'",[id])).rows[0];
      if(job?.status!=='READY_TO_POST'||!job.package.text_video?.input?.presenter||
         !job.package.text_video.plan.shots.some((s:any)=>s.id===b.scene))throw Error('เลือกฉาก UGC ที่เรนเดอร์เสร็จแล้ว');
      await pool.query(`INSERT INTO ugc_scene_reviews(job_id,scene_id,checks,note) VALUES($1,$2,$3,$4)
        ON CONFLICT(job_id,scene_id) DO UPDATE SET checks=excluded.checks,note=excluded.note`,[id,b.scene,json(b.checks),b.note]);
      return c.json({ok:true});
    } catch(e){return c.json({error:documentError(e)},409);}
  });
  app.get(P+'/jobs/:id',g,async c=>{
    try {
      const id=uuid.parse(c.req.param('id'));
      const j=(await pool.query("SELECT status,progress,error,package,result FROM jobs WHERE id=$1 AND package ? 'ugc' AND NOT (package->'ugc' ?| array['image','frame'])",[id])).rows[0];
      if (!j) return c.json({error:'ไม่พบงาน'},404);
      const [calls,usage]=await Promise.all([callsFor(id),pool.query(`SELECT c.slot,c.status,c.request_id,c.created_at,
        c.data->'actual_usd' AS actual_usd,c.data->'generated_duration' AS generated_duration,a.approval
        FROM text_video_calls c JOIN ugc_approvals a ON a.id=c.approval_id AND a.job_id=c.job_id
        WHERE c.job_id=$1 AND c.provider='fal' ORDER BY c.created_at,c.slot`,[id])]);
      const fal_usage=usage.rows.map(({approval,...call})=>{
        const item=approval.fal.find((x:any)=>x.slot===call.slot);
        const reused=approval.reused.includes(call.slot);
        return {...call,reused,model_name:item?.model_name,resolution:item?.resolution,
          estimated_usd:reused?null:item?.estimated_usd??null,actual_usd:reused?null:call.actual_usd??null};
      });
      const events=(await pool.query("SELECT message,data FROM job_events WHERE job_id=$1 AND data ? 'scene_id' ORDER BY id DESC LIMIT 40",[id])).rows;
      const reviews=(await pool.query('SELECT scene_id,checks,note FROM ugc_scene_reviews WHERE job_id=$1',[id])).rows;
      const exportNotes=j.package.ugc.export;
      return c.json({id,presenter:!!j.package.text_video.input.presenter,status:j.status,progress:j.progress,error:j.error,notes:exportNotes,fal_usage,
        scenes:await Promise.all(j.package.text_video.plan.shots.map(async (s:any,i:number)=>({id:s.id,mode:s.mode,seconds:s.seconds,
          speaking:!!j.package.text_video.input.presenter&&(i===0||i===j.package.text_video.plan.shots.length-1),
          technical:j.result?.scene_checks?.[s.id]||null,
          preview:j.result?.scene_previews?.[s.id]?await store?.sign(j.result.scene_previews[s.id]):null,
          review:reviews.find(r=>r.scene_id===s.id)||null,narration:s.narration,subtitle:s.subtitle||s.narration,
          state:events.find(e=>e.data.scene_id===s.id)?.data?.state||null,
          video:calls.find(x=>x.slot==='fal:'+s.id)?.status||null,voice:calls.find(x=>x.slot==='eleven:'+s.id)?.status||null}))),
        video:j.result?.final_key?await store?.sign(j.result.final_key):null,
        download:j.result?.final_key?await store?.sign(j.result.final_key,true):null});
    } catch(e){return c.json({error:documentError(e)},404);}
  });
  app.post('/internal/ugc/check-dispatch',options.workerGuard,async c=>{
    try {
      const b=z.object({job_id:uuid,approval_id:uuid,slot:z.string().regex(/^(?:(fal|eleven):shot_\d{2}|fal:opening_image)$/)}).strict().parse(await c.req.json());
      const r=(await pool.query(`SELECT a.approval,j.status,j.package FROM ugc_approvals a JOIN jobs j ON j.id=a.job_id
        JOIN ugc_drafts d ON d.id=a.draft_id
        WHERE a.id=$1 AND j.id=$2 AND j.removed_at IS NULL
          AND ((d.job_id=j.id AND d.approval->>'id'=$1::text) OR (d.image_job_id=j.id AND j.package->'ugc' ? 'image'))`,
        [b.approval_id,b.job_id])).rows[0];
      const a=r?.approval, w=await worker();
      if(!a||!w||!['GENERATING_AUDIO','RENDERING'].includes(r.status)||!r.package.ugc||digest(r.package.text_video.approval)!==digest(a)||
        !a.approved_at||!(Date.parse(a.valid_until)>Date.now())||!a.pending_slots.includes(b.slot)) throw Error('คำอนุมัติหมดอายุหรือไม่ตรงกับฉาก');
      if(b.slot==='fal:opening_image') {
        if(w.ugc_version!==3||!w.fal||!r.package.ugc.image)throw Error('งานเตรียมภาพยังไม่พร้อม');
        const approved=a.fal[0];
        const live={...await imagePrice(approved.endpoint_id,approved.payload.prompt,a.media.length===2),slot:'fal:opening_image'};
        const current={item:live,media:a.media,basis:a.basis};
        if(imageBinding(current)!==imageBinding({...current,item:approved}))throw Error('โมเดลหรือราคาภาพเปลี่ยน ต้องขอราคาใหม่');
      } else if (b.slot.startsWith('fal:')) {
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
