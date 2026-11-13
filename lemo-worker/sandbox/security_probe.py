"""Real sandbox checks; run only the fixed probe, never user source."""
import json,subprocess,uuid
from pathlib import Path
from executor import command,verify_runtime

image=Path('/opt/lemo/image-id.txt').read_text().strip()
limits=verify_runtime(image)
name='lemo-security-'+uuid.uuid4().hex
js=r"""
const fs=require('fs'),net=require('net');
(async()=>{
const result={uid:process.getuid(),dockerSocket:fs.existsSync('/var/run/docker.sock'),secretNames:Object.keys(process.env).filter(k=>/TOKEN|API_KEY|DATABASE|BUCKET|OPENAI|ELEVEN|RAILWAY/.test(k))};
try{fs.writeFileSync('/lemo-root-write','x');result.rootWrite='allowed'}catch(e){result.rootWrite=e.code}
const tmp=fs.statfsSync('/tmp');result.tmpBytes=tmp.bsize*tmp.blocks;
result.status=fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>/^(CapEff|NoNewPrivs):/.test(x));
result.network=await new Promise(resolve=>{const s=net.createConnection({host:'1.1.1.1',port:443});s.setTimeout(2000);s.on('connect',()=>{s.destroy();resolve('connected')});s.on('error',e=>resolve(e.code));s.on('timeout',()=>{s.destroy();resolve('timeout')})});
if(result.uid!==65534||result.dockerSocket||result.secretNames.length||!['EROFS','EACCES'].includes(result.rootWrite)||result.tmpBytes>384*1024*1024||!['ENETUNREACH','EHOSTUNREACH','timeout'].includes(result.network))throw Error('Isolation check failed: '+JSON.stringify(result));
console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.message);process.exit(1)});
"""
cmd=command(image,name)
cmd=cmd[:-1]+['--entrypoint','node',image,'-e',js]
try:
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
    if result.returncode:raise RuntimeError(result.stderr[-1600:])
    print(json.dumps({'limits':limits,'isolation':json.loads(result.stdout)}))
finally:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=10)
