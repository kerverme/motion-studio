// Temporary production verification proxy. No database, arbitrary URL or key export.
// Each provider has one fixed, bounded call slot, atomically reserved in object storage.
import {S3Client,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3@3.700.0';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner@3.700.0';
import {createHash,timingSafeEqual} from 'node:crypto';
const env=Bun.env,bucket=env.BUCKET!;
const s3=new S3Client({endpoint:env.BUCKET_ENDPOINT,region:env.BUCKET_REGION||'auto',forcePathStyle:env.BUCKET_URL_STYLE==='path',credentials:{accessKeyId:env.BUCKET_ACCESS_KEY_ID!,secretAccessKey:env.BUCKET_SECRET_ACCESS_KEY!}});
const prefix='lemo-verification/20261112/production-adapter-v1/';
const json=(value:unknown,status=200)=>Response.json(value,{status});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const isConflict=(error:any)=>[409,412].includes(error?.$metadata?.httpStatusCode);
async function get(name:string){try{const r=await s3.send(new GetObjectCommand({Bucket:bucket,Key:prefix+name}));return JSON.parse(await r.Body!.transformToString());}catch(e:any){if(e?.$metadata?.httpStatusCode===404)return null;throw e;}}
async function put(name:string,data:unknown,exclusive=false){await s3.send(new PutObjectCommand({Bucket:bucket,Key:prefix+name,Body:JSON.stringify(data),ContentType:'application/json',...(exclusive?{IfNoneMatch:'*'}:{})}));}
function authorized(req:Request){const a=Buffer.from(req.headers.get('xi-api-key')||''),b=Buffer.from(env.LEMO_PROBE_TOKEN||'');return b.length>20&&a.length===b.length&&timingSafeEqual(a,b);}
function replay(saved:any){return new Response(Buffer.from(saved.body,'base64'),{status:saved.status,headers:saved.headers});}
let busy=false,storageReady=false;
async function readiness(){
  if(!storageReady){
    try{await put('conditional-check.json',{purpose:'exclusive-create capability check'},true);}catch(e){if(!isConflict(e))throw e;}
    let rejected=false;try{await put('conditional-check.json',{unexpected:'overwrite'},true);}catch(e){if(!isConflict(e))throw e;rejected=true;}
    if(!rejected)throw Error('Object storage did not enforce exclusive create; paid requests blocked');
    storageReady=true;
  }
  return {ready:true,one_call_slots:['tts-v4','sfx-v3'],provider_keys_exported:false};
}
async function handle(req:Request){
  const url=new URL(req.url);
  if(url.pathname==='/health')return json({service:'lemo-adapter-check',generation_slots:2});
  if(!authorized(req))return json({error:'Unauthorized'},401);
  try{
    if(req.method==='GET'&&url.pathname==='/ready')return json(await readiness());
    if(req.method!=='POST')return json({error:'Method not allowed'},405);
    if(Number(req.headers.get('content-length')||0)>8000)return json({error:'Input too large'},413);
    const raw=await req.text();if(raw.length>8000)return json({error:'Input too large'},413);
    const body=JSON.parse(raw);let slot:string;
    if(url.pathname==='/v1/text-to-dialogue/with-timestamps'){
      if(body.model_id!=='eleven_v4'||body.language_code!=='th'||body.inputs?.length!==1||body.inputs[0].voice_id!==env.MOTION_DEFAULT_VOICE_ID||typeof body.inputs[0].text!=='string'||body.inputs[0].text.length>160||!body.inputs[0].text.length)return json({error:'Outside approved short v4 test'},422);
      slot='tts-v4';
    }else if(url.pathname==='/v1/sound-generation'){
      if(body.model_id!=='eleven_text_to_sound_v3'||body.loop!==false||typeof body.text!=='string'||body.text.length>300||!Number.isFinite(body.duration_seconds)||body.duration_seconds<.5||body.duration_seconds>2)return json({error:'Outside approved short SFX v3 test'},422);
      slot='sfx-v3';
    }else return json({error:'Unknown provider operation'},404);
    await readiness();const hash=digest(raw),saved=await get(slot+'.complete.json');
    if(saved){if(saved.payload_hash!==hash)return json({error:'Slot already used by different input'},409);return replay(saved);}
    if(busy)return json({error:'Verification busy; do not submit another generation'},409);
    busy=true;
    try{
      try{await put(slot+'.started.json',{payload_hash:hash,model:body.model_id,created_at:new Date().toISOString()},true);}catch(e){if(!isConflict(e))throw e;return json({error:'Call was already submitted; reconcile saved outcome before retry'},409);}
      const response=await fetch('https://api.elevenlabs.io'+url.pathname+'?output_format=mp3_44100_128',{method:'POST',headers:{'xi-api-key':env.ELEVENLABS_API_KEY!,'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(180000)});
      const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>5*1024*1024)throw Error('Provider output exceeds verification limit');
      const headers=Object.fromEntries(['content-type','request-id','character-cost','x-character-count'].map(k=>[k,response.headers.get(k)]).filter((x):x is [string,string]=>x[1]!==null));
      const result={payload_hash:hash,status:response.status,headers,body:bytes.toString('base64'),completed_at:new Date().toISOString()};
      await put(slot+'.complete.json',result);
      console.log(JSON.stringify({event:'adapter_verification_complete',slot,status:result.status,request_id:headers['request-id'],character_cost:headers['character-cost']||headers['x-character-count'],bytes:bytes.length}));
      return replay(result);
    }finally{busy=false;}
  }catch(error:any){console.log(JSON.stringify({event:'adapter_verification_error',type:error.name}));return json({error:'Verification failed; any submitted request remains reserved. Inspect durable evidence before retry.'},502);}
}
// Keep this verification service private. No public domain is needed.
Bun.serve({port:Number(env.PORT||8080),idleTimeout:255,fetch:handle});
if(env.LEMO_RUN_LIVE_CHECK==='true'){
  const checks=[
    {slot:'tts-v4',path:'/v1/text-to-dialogue/with-timestamps',body:{inputs:[{text:'ถ้าแมวพูดได้หนึ่งวัน มันคงไม่บอกรักเราก่อน แต่จะถามว่า มนุษย์ ทำไมชามข้าวยังว่าง?',voice_id:env.MOTION_DEFAULT_VOICE_ID}],model_id:'eleven_v4',language_code:'th',settings:{stability:.4,similarity:.75}}},
    {slot:'sfx-v3',path:'/v1/sound-generation',body:{text:'One gentle ceramic cat food bowl tap, short playful dry foley, no speech, no music.',duration_seconds:1,prompt_influence:.5,model_id:'eleven_text_to_sound_v3',loop:false}},
  ];
  for(const check of checks){
    try{
      const response=await handle(new Request('http://localhost'+check.path,{method:'POST',headers:{'xi-api-key':env.LEMO_PROBE_TOKEN!,'content-type':'application/json'},body:JSON.stringify(check.body)}));
      const saved=await get(check.slot+'.complete.json');
      const artifact_url=saved?await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:prefix+check.slot+'.complete.json'}),{expiresIn:1800}):null;
      console.log(JSON.stringify({event:'live_check_evidence',slot:check.slot,status:response.status,artifact_url}));
      if(response.status!==200)break;
    }catch(error:any){console.log(JSON.stringify({event:'live_check_stopped',type:error.name}));break;}
  }
}
