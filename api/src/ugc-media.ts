import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export const MAX_MEDIA = 32*1024*1024;
export type AssetStore = {
  put(key:string, bytes:Buffer, type:string):Promise<void>;
  sign(key:string, download?:boolean):Promise<string|null>;
};
export async function readMedia(stream:ReadableStream<Uint8Array>|null, length:string|null|undefined) {
  if (!stream || (length && Number(length)>MAX_MEDIA)) throw Error('ไฟล์ต้องมีขนาดไม่เกิน 32 MB');
  const reader=stream.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  try {
    for (;;) {
      const next=await reader.read();
      if (next.done) break;
      size+=next.value.length;
      if (size>MAX_MEDIA) throw Error('ไฟล์ต้องมีขนาดไม่เกิน 32 MB');
      chunks.push(next.value);
    }
  } finally {void reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,size);
}

export async function saveMedia(pool:pg.Pool, store:AssetStore, draft:string, bytes:Buffer, role:'product'|'presenter'='product') {
  const type=bytes.length>=16 && (bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg'
    :bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png'
    :bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP'?'image/webp'
    :bytes.toString('ascii',4,8)==='ftyp'?'video/mp4':null);
  if (!type) throw Error('รองรับไฟล์ JPEG, PNG, WebP หรือ MP4');
  const id=randomUUID(), key='ugc-r2/v1/originals/'+draft+'/'+id;
  await store.put(key,bytes,type);
  const kind=type.startsWith('video')?'video':'image';
  await pool.query('INSERT INTO ugc_media(id,draft_id,kind,content_type,storage_key,bytes,role) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id,draft,kind,type,key,bytes.length,role]);
  return {id,kind,role,content_type:type,url:await store.sign(key)};
}
