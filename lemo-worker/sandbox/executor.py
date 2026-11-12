"""Dedicated trusted host only; never deploy a Docker socket in the worker.

Fixed container command, bounded input/output, no bind mounts or inherited secrets.
"""
import hashlib, io, json, os, re, subprocess, tarfile, threading, time, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from hmac import compare_digest

LOCK = threading.BoundedSemaphore(1)
MAX_OUTPUT = 96 * 1024 * 1024


def command(image, name):
    if not re.fullmatch(r'(?:[a-zA-Z0-9_./:-]+@)?sha256:[0-9a-f]{64}', image):
        raise ValueError('LEMO_SANDBOX_IMAGE must be an immutable image digest')
    return ['docker','run','--name',name,'--runtime=runsc','--network=none','--read-only','--user=65534:65534',
            '--cap-drop=ALL','--security-opt=no-new-privileges','--cpus=2','--memory=2g','--memory-swap=2g',
            '--pids-limit=256','--ulimit=nofile=1024:1024','--ulimit=fsize=134217728:134217728',
            '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=384m,mode=1777','--shm-size=64m','--log-driver=none','-i',image]


def verify_runtime(image):
    """Fail closed unless the runtime exposes the limits actually enforced.

    HostConfig is intent, not proof. Development runsc --ignore-cgroups must fail.
    """
    inspector="const fs=require('fs');for(const p of ['memory.max','cpu.max','pids.max'])console.log(p+'='+fs.readFileSync('/sys/fs/cgroup/'+p,'utf8').trim());"
    cmd=command(image,'lemo-probe-'+uuid.uuid4().hex)
    name=cmd[cmd.index('--name')+1]
    cmd=cmd[:-1]+['--entrypoint','node',image,'-e',inspector]
    try:
        result=subprocess.run(cmd,capture_output=True,text=True,timeout=25)
        limits=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        if result.returncode or limits.get('memory.max')!='2147483648' or limits.get('pids.max')!='256':
            raise RuntimeError('Runtime resource enforcement is unverified; generated code is blocked')
        quota,period=map(int,limits['cpu.max'].split())
        if quota/period>2:raise RuntimeError('Runtime CPU quota is not enforced')
        return limits
    finally:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=10)


def run(spec, image=None, timeout=300, *, trusted_fixture=False):
    payload=json.dumps(spec).encode()
    if len(payload)>800000:raise ValueError('Input too large')
    image=image or os.environ['LEMO_SANDBOX_IMAGE']
    if trusted_fixture:
        # Test-only escape for committed hand-authored fixtures, never the HTTP route.
        manifest=json.loads((Path(__file__).parents[1]/'tests/fixtures/trusted-render-hashes.json').read_text())
        if hashlib.sha256(spec.get('html','').encode()).hexdigest() not in manifest or spec.get('duration',999)>10:
            raise ValueError('Only reviewed immutable fixtures can bypass unverified development quotas')
    else:verify_runtime(image)
    if not LOCK.acquire(blocking=False):raise RuntimeError('Renderer busy')
    name='lemo-'+uuid.uuid4().hex
    process=None
    try:
        start=time.monotonic()
        process=subprocess.Popen(command(image,name),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        process.stdin.write(payload);process.stdin.close()
        output=bytearray();errors=bytearray();stats=[]
        def collect(stream,target,limit):
            while chunk:=stream.read(65536):
                target.extend(chunk)
                if len(target)>limit:
                    subprocess.run(['docker','kill',name],capture_output=True,timeout=10);break
        threads=[threading.Thread(target=collect,args=(process.stdout,output,MAX_OUTPUT)),threading.Thread(target=collect,args=(process.stderr,errors,16000))]
        for thread in threads:thread.start()
        while process.poll() is None:
            if time.monotonic()-start>timeout:
                raise TimeoutError('Render execution time exceeded')
            sample=subprocess.run(['docker','stats','--no-stream','--format','{{json .}}',name],capture_output=True,text=True,timeout=10)
            if sample.returncode==0:
                for line in sample.stdout.splitlines():
                    try:stats.append(json.loads(line))
                    except ValueError:pass
            time.sleep(.1)
        for thread in threads:thread.join(timeout=10)
        if process.returncode or len(output)>MAX_OUTPUT:raise RuntimeError(bytes(errors).decode(errors='replace')[:2000] or 'Sandbox failed')
        validate_archive(bytes(output))
        return bytes(output),{'wall_seconds':time.monotonic()-start,'docker_stats':stats,'stats_scope':'unverified-host-aggregate' if trusted_fixture else 'container','image':image,'runtime':'runsc','output_bytes':len(output),'trusted_fixture_only':trusted_fixture}
    finally:
        subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=20)
        if process and process.poll() is None:process.kill();process.wait()
        LOCK.release()


def validate_archive(data):
    allowed={'video.mp4','preview-0.png','preview-1.png','preview-2.png','metadata.json'}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        members=archive.getmembers()
        if {m.name for m in members}!=allowed or len(members)!=len(allowed):raise ValueError('Unexpected artifact names')
        if any(not m.isfile() or m.size>MAX_OUTPUT for m in members):raise ValueError('Unsafe artifact type')
        return {m.name:archive.extractfile(m).read() for m in members}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path=='/ready':
            token=os.environ.get('LEMO_EXECUTOR_TOKEN','')
            if not token or not compare_digest(self.headers.get('Authorization',''),'Bearer '+token):self.send_error(403);return
            try:body={'ready':True,'image':os.environ['LEMO_SANDBOX_IMAGE'],'limits':verify_runtime(os.environ['LEMO_SANDBOX_IMAGE'])};status=200
            except Exception as error:body={'ready':False,'error':str(error)[:300]};status=503
            self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(body).encode());return
        self.send_response(200 if self.path=='/health' else 404);self.end_headers()
        self.wfile.write(b'{"service":"lemo-executor","runtime":"runsc"}')
    def do_POST(self):
        token=os.environ.get('LEMO_EXECUTOR_TOKEN','')
        if self.path!='/render' or not token or not compare_digest(self.headers.get('Authorization',''),'Bearer '+token):
            self.send_error(403);return
        length=int(self.headers.get('Content-Length','0'))
        if not 0<length<=800000:self.send_error(413);return
        try:
            result,stats=run(json.loads(self.rfile.read(length)))
            self.send_response(200);self.send_header('Content-Type','application/x-tar');self.send_header('Content-Length',str(len(result)));self.end_headers();self.wfile.write(result)
        except Exception as error:
            # Never echo submitted source or environment back in an error.
            message=json.dumps({'error':type(error).__name__,'detail':str(error)[:1800]}).encode()
            self.send_response(422);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(message)));self.end_headers();self.wfile.write(message)
    def log_message(self,*args):pass


if __name__=='__main__':
    ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('PORT','8091'))),Handler).serve_forever()
