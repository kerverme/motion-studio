// Deploy as a private Railway Function. No public domain, database or provider keys.
import {Sandbox} from 'railway@3.16.0';
import {timingSafeEqual} from 'node:crypto';
const env=Bun.env,MAX_OUTPUT=96*1024*1024;
let busy=false;
const configured=()=>Boolean(env.RAILWAY_TOKEN&&env.LEMO_SANDBOX_CHECKPOINT&&env.LEMO_SANDBOX_IMAGE&&env.LEMO_EXECUTOR_TOKEN&&env.LEMO_TLS_CERT&&env.LEMO_TLS_KEY);
function authorized(req:Request){
  const supplied=Buffer.from(req.headers.get('authorization')||''),expected=Buffer.from('Bearer '+(env.LEMO_EXECUTOR_TOKEN||''));
  return Boolean(env.LEMO_EXECUTOR_TOKEN)&&supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
async function sandboxOperation(mode:'ready'|'render',spec?:unknown){
  if(busy)throw Error('Renderer busy');
  busy=true;let box:Sandbox|undefined;
  try{
    box=await Sandbox.create(env.LEMO_SANDBOX_CHECKPOINT!,{
      token:env.RAILWAY_TOKEN!,authType:'project-token',environmentId:env.RAILWAY_ENVIRONMENT_ID!,
      resources:{cpu:2,memoryGB:4},networkIsolation:'ISOLATED',idleTimeoutMinutes:5,env:{},
    });
    if(box.networkIsolation!=='ISOLATED'||box.domains.length)throw Error('Unexpected sandbox network configuration');
    if(mode==='render')await box.files.write('/tmp/lemo-input.json',JSON.stringify(spec),{mode:0o600});
    const result=await box.exec('python3 /opt/lemo/sandbox/railway_job.py '+mode,{timeoutSec:mode==='ready'?30:330,maxOutputBytes:16000});
    if(result.exitCode!==0||result.timedOut||result.truncated)throw Error('Sandbox '+mode+' failed: '+result.stderr.slice(-1200));
    const metadata=JSON.parse(result.stdout);
    if(metadata.image!==env.LEMO_SANDBOX_IMAGE)throw Error('Renderer image differs from approved image');
    if(mode==='ready')return {metadata};
    const info=await box.files.stat('/tmp/lemo-output.tar');
    if(info.isDir||info.size>MAX_OUTPUT||info.size<=0)throw Error('Renderer output exceeds limit');
    const archive=await box.files.read('/tmp/lemo-output.tar',{format:'bytes',length:MAX_OUTPUT+1});
    if(archive.length>MAX_OUTPUT)throw Error('Renderer output exceeds limit');
    return {metadata,archive};
  }finally{
    if(box)try{await box.destroy();}catch(error:any){console.error(JSON.stringify({event:'sandbox_cleanup_pending',id:box.id,type:error.name}));}
    busy=false;
  }
}
async function handle(req:Request){
  if(!authorized(req))return Response.json({error:'Unauthorized'},{status:401});
  if(!configured())return Response.json({error:'Executor not configured'},{status:503});
  if(busy)return Response.json({error:'Renderer busy; retain job checkpoint'},{status:409});
  const path=new URL(req.url).pathname;
  try{
    if(req.method==='GET'&&path==='/ready')return Response.json((await sandboxOperation('ready')).metadata);
    if(req.method!=='POST'||path!=='/render')return Response.json({error:'Not found'},{status:404});
    const raw=await req.text();if(Buffer.byteLength(raw)>800000)return Response.json({error:'Input too large'},{status:413});
    const spec=JSON.parse(raw);
    if(typeof spec.html!=='string'||spec.html.length>600000||![360,540,1080].includes(spec.width)||spec.height!==spec.width*16/9||spec.fps!==30||!Number.isFinite(spec.duration)||spec.duration<=0||spec.duration>40)return Response.json({error:'Invalid render specification'},{status:422});
    const result=await sandboxOperation('render',spec);
    console.log(JSON.stringify({event:'render_complete',seconds:result.metadata.wall_seconds,bytes:result.archive!.length,image:result.metadata.image}));
    return new Response(result.archive!,{headers:{'content-type':'application/x-tar'}});
  }catch(error:any){
    console.error(JSON.stringify({event:'render_error',type:error.name}));
    return Response.json({error:String(error.message).slice(0,1600)},{status:422});
  }
}
// The plaintext listener exposes health only, for Railway's healthcheck.
Bun.serve({port:Number(env.PORT||8080),hostname:'::',fetch:req=>new URL(req.url).pathname==='/health'?Response.json({service:'lemo-render-executor',configured:configured(),busy}):new Response('Not found',{status:404})});
if(env.LEMO_TLS_CERT&&env.LEMO_TLS_KEY)Bun.serve({port:8443,hostname:'::',tls:{cert:env.LEMO_TLS_CERT,key:env.LEMO_TLS_KEY},idleTimeout:255,maxRequestBodySize:800000,fetch:(req,server)=>{server.timeout(req,0);return handle(req);}});
