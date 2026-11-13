import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';

export type SealedAsset={storage_key:string;sha256:string;bytes:number;encryption:{algorithm:'aes-256-gcm';iv:string;tag:string;key_id:string}};
function key(){const v=process.env.MOTION_REVERSE_STORAGE_KEY||'';if(!/^[0-9a-f]{64}$/.test(v))throw Error('Private reverse storage key is not configured');return Buffer.from(v,'hex');}
export function keyId(){return createHash('sha256').update(key()).digest('hex').slice(0,16);}
export function privateStorage(){
  const e=process.env;if(!e.BUCKET||!e.BUCKET_ACCESS_KEY_ID||!e.BUCKET_SECRET_ACCESS_KEY)throw Error('Private artifact storage is not configured');
  const client=new S3Client({region:e.BUCKET_REGION||'auto',endpoint:e.BUCKET_ENDPOINT||undefined,
    forcePathStyle:e.BUCKET_URL_STYLE==='path',credentials:{accessKeyId:e.BUCKET_ACCESS_KEY_ID,secretAccessKey:e.BUCKET_SECRET_ACCESS_KEY}});
  return {client,bucket:e.BUCKET};
}
export async function sealUpload(body:Readable,storageKey:string,expectedHash:string,maxBytes:number,store=privateStorage()):Promise<SealedAsset>{
  const dir=await mkdtemp(join(tmpdir(),'motion-reverse-')),path=join(dir,'asset.sealed'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
  const hash=createHash('sha256');let bytes=0;
  const measure=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>maxBytes){callback(Error('Source exceeds its declared upload size'));return;}hash.update(chunk);callback(null,chunk);}});
  try{
    await pipeline(body,measure,cipher,createWriteStream(path,{mode:0o600}));
    const actual=hash.digest('hex');if(actual!==expectedHash||!bytes)throw Error('Uploaded source checksum mismatch');
    await store.client.send(new PutObjectCommand({Bucket:store.bucket,Key:storageKey,Body:createReadStream(path),ContentLength:bytes,ContentType:'application/octet-stream'}));
    return {storage_key:storageKey,sha256:actual,bytes,encryption:{algorithm:'aes-256-gcm',iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),key_id:keyId()}};
  }finally{await rm(dir,{recursive:true,force:true});}
}
export async function readPrivateAsset(asset:any,store=privateStorage()):Promise<Buffer>{
  if(asset.bytes>32*1024*1024)throw Error('Use source streaming rather than the bounded artifact reader');
  const response=await store.client.send(new GetObjectCommand({Bucket:store.bucket,Key:asset.storage_key}));
  const bytes=Buffer.from(await response.Body!.transformToByteArray());
  if(!asset.encryption)throw Error('Private reverse assets must be encrypted');
  if(asset.encryption.key_id!==keyId())throw Error('Asset encryption key is unavailable');
  const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(asset.encryption.iv,'hex'));
  decipher.setAuthTag(Buffer.from(asset.encryption.tag,'hex'));
  const plain=Buffer.concat([decipher.update(bytes),decipher.final()]);
  if(createHash('sha256').update(plain).digest('hex')!==asset.sha256)throw Error('Artifact checksum mismatch');
  return plain;
}

/** Authenticate before releasing plaintext; stream large exports from a private temp file. */
export async function streamPrivateAsset(asset:any,store=privateStorage()):Promise<ReadableStream<Uint8Array>>{
  if(!asset.encryption||asset.encryption.key_id!==keyId()||asset.bytes>1024*1024*1024)throw Error('Private asset key/size is invalid');
  const dir=await mkdtemp(join(tmpdir(),'reverse-read-')),path=join(dir,'plain');
  try{
    const r=await store.client.send(new GetObjectCommand({Bucket:store.bucket,Key:asset.storage_key}));
    const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(asset.encryption.iv,'hex'));decipher.setAuthTag(Buffer.from(asset.encryption.tag,'hex'));
    const hash=createHash('sha256');let bytes=0;
    const measure=new Transform({transform(chunk,_enc,cb){bytes+=chunk.length;if(bytes>Number(asset.bytes)){cb(Error('Asset exceeds declared size'));return;}hash.update(chunk);cb(null,chunk);}});
    await pipeline(r.Body as Readable,decipher,measure,createWriteStream(path,{mode:0o600}));
    if(bytes!==Number(asset.bytes)||hash.digest('hex')!==asset.sha256)throw Error('Private artifact checksum mismatch');
    const reader=createReadStream(path);reader.on('close',()=>{void rm(dir,{recursive:true,force:true});});return Readable.toWeb(reader) as ReadableStream<Uint8Array>;
  }catch(e){await rm(dir,{recursive:true,force:true});throw e;}
}
