import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {Readable} from 'node:stream';
import {createCipheriv,createHash} from 'node:crypto';
import {registerReverse} from './reverse.js';
import {streamPrivateAsset,keyId} from './reverse-storage.js';

const content=Buffer.from('0123456789'),id='11111111-1111-4111-8111-111111111111';
const asset={id,bytes:10,content_type:'video/mp4'};
let reads=0;const app=new Hono();
registerReverse(app,{query:async()=>({rows:[asset]})} as any,{
 guard:async(c,n)=>c.req.header('x-owner')==='yes'?n():c.json({error:'unauthorized'},401),
 asset:async()=>{reads++;return content;}
});
const get=(range?:string,authorized=true)=>app.request('/app/api/reverse/assets/'+id,{headers:{...(authorized?{'x-owner':'yes'}:{}),...(range?{Range:range}:{})}});

test('video asset supports full, bounded, suffix and open ended byte requests',async()=>{
 for(const [range,start,end,status] of [[undefined,0,9,200],['bytes=2-5',2,5,206],['bytes=7-',7,9,206],['bytes=-4',6,9,206],['bytes=8-999',8,9,206],['bytes=-99',0,9,206]] as const){
  const response=await get(range);assert.equal(response.status,status);assert.equal(response.headers.get('Accept-Ranges'),'bytes');assert.equal(response.headers.get('Content-Length'),String(end-start+1));
  assert.equal(response.headers.get('Content-Range'),status===206?`bytes ${start}-${end}/10`:null);
  assert.equal(await response.text(),content.subarray(start,end+1).toString());
 }
});

test('invalid/multipart ranges return 416 before decrypting, and authorization stays required',async()=>{
 const before=reads;
 for(const range of ['bytes=10-','bytes=7-2','bytes=-0','bytes=-','bytes=0-1,4-5','bytes=9007199254740992-','items=0-1']){
  const response=await get(range);assert.equal(response.status,416);assert.equal(response.headers.get('Content-Range'),'bytes */10');
 }
 assert.equal(reads,before);assert.equal((await get('bytes=0-1',false)).status,401);assert.equal(reads,before);
});

test('range playback authenticates the complete encrypted video before returning selected plaintext',async()=>{
 const old=process.env.MOTION_REVERSE_STORAGE_KEY;process.env.MOTION_REVERSE_STORAGE_KEY='ab'.repeat(32);
 try{
  const iv=Buffer.alloc(12,3),cipher=createCipheriv('aes-256-gcm',Buffer.from(process.env.MOTION_REVERSE_STORAGE_KEY,'hex'),iv),sealed=Buffer.concat([cipher.update(content),cipher.final()]);
  const record={...asset,storage_key:'fixture',sha256:createHash('sha256').update(content).digest('hex'),encryption:{algorithm:'aes-256-gcm',iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),key_id:keyId()}};
  const store=(data:Buffer)=>({bucket:'test',client:{send:async()=>({Body:Readable.from([data])})}} as any);
  const stream=await streamPrivateAsset(record,store(sealed),{start:2,end:5});assert.equal(await new Response(stream).text(),'2345');
  const corrupt=Buffer.from(sealed);corrupt[9]^=1;
  await assert.rejects(streamPrivateAsset(record,store(corrupt),{start:2,end:5}));
 }finally{if(old===undefined)delete process.env.MOTION_REVERSE_STORAGE_KEY;else process.env.MOTION_REVERSE_STORAGE_KEY=old;}
});
