import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { uuid, blank } from './ugc-contract.js';
import { mediaType, readMedia, saveMedia, type AssetStore } from './ugc-media.js';

const fields=['name','variant','price','promo','selling_points','order_url','media'] as const;
const Mapping=z.object({database_id:uuid,fields:z.object(Object.fromEntries(fields.map(k=>[k,z.string().max(240)])) as Record<typeof fields[number],z.ZodString>).strict()}).strict();
type MappingInput=z.infer<typeof Mapping>;
const textTypes=['title','rich_text','number','select','multi_select','url'];
const types=(field:string)=>field==='media'?['files']:field==='price'?['number','rich_text']:field==='order_url'?['url','rich_text']:textTypes;

export function notionProducts(pool:pg.Pool, store:AssetStore|null, request=fetch, env=process.env) {
  const allowed=(env.UGC_NOTION_DATABASE_IDS||'').split(',').map(x=>normalize(x.trim())).filter(x=>uuid.safeParse(x).success);
  const enabled=!!env.UGC_NOTION_TOKEN && allowed.length>0;
  const verify=(id:string)=>{if(!enabled || !allowed.includes(id)) throw Error('ฐานสินค้าไม่ได้ตั้งค่าใน UGC_NOTION_DATABASE_IDS');};
  const call=async (path:string, body?:unknown)=>{
    const r=await request('https://api.notion.com/v1'+path,{redirect:'error',signal:AbortSignal.timeout(12000),
      method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.UGC_NOTION_TOKEN,'Notion-Version':'2022-06-28','Content-Type':'application/json'},
      body:body?JSON.stringify(body):undefined});
    if (!r.ok) throw Error('Notion HTTP '+r.status+' ตรวจสิทธิ์ฐานข้อมูลและการตั้งค่า');
    return r.json();
  };
  const columns=async (id:string)=>{
    verify(id);
    const d=await call('/databases/'+id);
    return Object.values(d.properties||{}).map((p:any)=>({id:String(p.id),name:String(p.name),type:String(p.type)}));
  };
  const config=async ():Promise<MappingInput|null>=>{
    const row=(await pool.query("SELECT data FROM integrations WHERE provider='ugc_product_notion'")).rows[0];
    return row && allowed.includes(row.data.database_id)?Mapping.parse(row.data):null;
  };
  const validate=async (value:unknown)=>{
    const m=Mapping.parse(value);
    const props=await columns(m.database_id);
    if (!m.fields.name || Object.entries(m.fields).some(([k,v])=>v&&!props.some(p=>p.id===v&&types(k).includes(p.type))))
      throw Error('เลือกคอลัมน์ชื่อสินค้าและชนิดฟิลด์ให้ตรงกับฐานจริง');
    return m;
  };
  const extract=(p:any,m:MappingInput)=>{
    const props=Object.values(p.properties||{}) as any[];
    const field=(k:typeof fields[number])=>props.find(prop=>prop.id===m.fields[k]);
    const product=blank().product;
    for (const k of fields) {
      if (k==='media') continue;
      const f=field(k);
      const raw=f?.[f?.type];
      const value=typeof raw==='number'||typeof raw==='string'?String(raw)
        :Array.isArray(raw)?raw.map(t=>t.plain_text||t.name||'').join(f.type==='multi_select'?' · ':'')
        :raw?.name || '';
      if (k==='price' && !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) continue;
      if (k==='order_url' && !/^https:\/\//i.test(value)) continue;
      product[k]=value.slice(0,({name:140,variant:80,price:32,promo:100,selling_points:1400,order_url:2048})[k]);
    }
    return {product, files:(field('media')?.files||[]) as any[]};
  };
  const reviewerDb=normalize(env.UGC_NOTION_REVIEWER_DATABASE_ID?.trim()||'');
  const reviewersEnabled=!!env.UGC_NOTION_TOKEN && uuid.safeParse(reviewerDb).success;
  async function reviewerFields(){
    if(!reviewersEnabled)throw Error('ยังไม่ได้ตั้งค่าฐานคนรีวิว Notion');
    const db=await call('/databases/'+reviewerDb);
    const props=Object.values(db.properties||{}) as {id:string;name:string;type:string}[];
    const title=props.find(x=>x.type==='title');
    const images=props.filter(x=>x.type==='files');
    const chosen=env.UGC_NOTION_REVIEWER_IMAGE_PROPERTY;
    const files=chosen?images.find(x=>x.id===chosen||x.name===chosen):images.length===1?images[0]:undefined;
    if(!title||!files)throw Error('ระบุคอลัมน์ Files & media สำหรับรูปคนรีวิวใน UGC_NOTION_REVIEWER_IMAGE_PROPERTY');
    return {title:title.id,files:files.id};
  }
  function portraits(page:any,fields:{title:string;files:string}){
    const props=Object.values(page.properties||{}) as any[];
    const name=String(props.find(p=>p.id===fields.title)?.title?.map((t:any)=>t.plain_text||'').join('')||'').trim();
    const files=props.find(p=>p.id===fields.files)?.files??[];
    return files.flatMap((file:any)=>{
      const url=file[file.type]?.url;
      if(!name||!hostedFile(url)||!file.name||!(/\.(?:jpe?g|webp|png)$/i.test(file.name)||/\.(?:jpe?g|webp|png)$/i.test(new URL(url).pathname)))return [];
      const address=new URL(url);
      const key=createHash('sha256').update(JSON.stringify([file.name,address.pathname,address.searchParams.get('id')])).digest('hex');
      return [{page:page.id,name,file:key,filename:String(file.name),url}];
    }) as {page:string;name:string;file:string;filename:string;url:string}[];
  }
  // Only thumbnails reuse the short-lived URL returned by the database query.
  // Import resolves the page again and copies its bytes into private Studio storage.
  const previews=new Map<string,{url:string;until:number}>();
  const previewKey=(page:string,file:string)=>JSON.stringify([page,file]);
  async function lookupPortrait(pageId:string,file:string){
    const fields=await reviewerFields();
    const p=await call('/pages/'+uuid.parse(pageId));
    if(p.archived||p.in_trash||normalize(p.parent?.database_id||'')!==reviewerDb)throw Error('รูปคนรีวิวอยู่นอกฐานที่ตั้งไว้');
    const selected=portraits(p,fields).find(x=>x.file===file);
    if(!selected)throw Error('ไม่พบรูปคนรีวิวที่เลือกใน Notion');
    return selected.url;
  }
  const reviewers={
    enabled:reviewersEnabled,
    list:async(query:string,cursor?:string)=>{
      const fields=await reviewerFields();
      const page=await call('/databases/'+reviewerDb+'/query',{page_size:25,
        ...(query?{filter:{property:fields.title,title:{contains:query}}}:{}),...(cursor?{start_cursor:uuid.parse(cursor)}:{})});
      const items=(page.results as any[]).filter(p=>!p.archived&&!p.in_trash).flatMap(p=>portraits(p,fields)).map(({page,name,file,filename,url})=>{
        const key=previewKey(page,file);
        previews.delete(key);
        previews.set(key,{url,until:Date.now()+60_000});
        if(previews.size>200)previews.delete(previews.keys().next().value!);
        return {page,name,file,filename,thumbnail:'/app/api/ugc/notion/reviewers/'+page+'/image?file='+encodeURIComponent(file)};
      });
      return {items,next:page.has_more?page.next_cursor:null};
    },
    image:async(pageId:string,file:string,thumbnail=false)=>{
      const cached=thumbnail?previews.get(previewKey(pageId,file)):undefined;
      const download=(url:string)=>request(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
      const preview=cached&&cached.until>Date.now()?await download(cached.url):null;
      const response=preview?.ok?preview:await download(await lookupPortrait(pageId,file));
      if(!response.ok)throw Error('ดาวน์โหลดรูปคนรีวิวจาก Notion ไม่สำเร็จ');
      const bytes=await readMedia(response.body,response.headers.get('content-length'));
      const type=mediaType(bytes);
      if(!type||!type.startsWith('image/'))throw Error('รูปคนรีวิวต้องเป็น JPEG, PNG หรือ WebP');
      return {bytes,type};
    },
  };
  return {enabled,allowed,columns,config,reviewers,
    save:async (value:unknown)=>{
      const m=await validate(value);
      await pool.query("INSERT INTO integrations(provider,data) VALUES('ugc_product_notion',$1) ON CONFLICT(provider) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",[JSON.stringify(m)]);
      return m;
    },
    list:async (cursor?:string)=>{
      const m=await config();if (!m) throw Error('ตั้งค่า mapping ของฐานสินค้า Notion ก่อน');
      const rows=await call('/databases/'+m.database_id+'/query',{page_size:30,...(cursor?{start_cursor:uuid.parse(cursor)}:{})});
      return {items:(rows.results||[]).map((p:any)=>({id:p.id,name:extract(p,m).product.name})).filter((p:any)=>p.name),
        next:rows.next_cursor||null};
    },
    imported:async (draft:string,page:string)=>{
      const m=await config();if (!m) throw Error('ตั้งค่า mapping ของฐานสินค้า Notion ก่อน');
      const p=await call('/pages/'+uuid.parse(page));
      if (normalize(p.parent?.database_id||'')!==m.database_id) throw Error('สินค้าอยู่นอกฐานที่ตั้งไว้');
      const {product,files}=extract(p,m);
      const asset=files.find(f=>f.type==='file'&&hostedFile(f.file?.url));
      let warning=files.length?'ดาวน์โหลดสื่อจาก Notion แล้วอัปโหลดใน Studio หากไฟล์อ้างอิงไม่ถูกนำเข้า':'';
      if (store && asset) {
        try {
          const r=await request(asset.file.url,{redirect:'error',signal:AbortSignal.timeout(30000)});
          if (!r.ok) throw Error('Notion file unavailable');
          const media=await saveMedia(pool,store,draft,await readMedia(r.body,r.headers.get('content-length')));
          return {product,media};
        } catch {warning='นำเข้าไฟล์จาก Notion ไม่สำเร็จ กรุณาอัปโหลดสื่อสินค้าใน Studio';}
      }
      return {product,warning};
    },
  };
}

function normalize(s:string) {
  const h=s.replaceAll('-','').toLowerCase();
  return h.replace(/^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/,'$1-$2-$3-$4-$5');
}
function hostedFile(value:unknown) {
  if (typeof value!=='string') return false;
  try {
    const u=new URL(value);
    return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&
      ['prod-files-secure.s3.us-west-2.amazonaws.com','s3.us-west-2.amazonaws.com','file.notion.so'].includes(u.hostname)&&
      (u.hostname!=='s3.us-west-2.amazonaws.com'||u.pathname.startsWith('/prod-files-secure/'));
  } catch {return false;}
}
