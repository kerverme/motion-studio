"""Dedicated trusted host only; never deploy a Docker socket in the worker.

Fixed container command, bounded input/output, no bind mounts or inherited secrets.
"""
import hashlib, io, json, os, re, subprocess, tarfile, threading, time, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from hmac import compare_digest

LOCK = threading.BoundedSemaphore(1)
MAX_OUTPUT = 96 * 1024 * 1024
MAX_PIDS = 1024  # Includes gVisor's host threads, Chromium and FFmpeg.


def command(image, name):
    if not re.fullmatch(r'(?:[a-zA-Z0-9_./:-]+@)?sha256:[0-9a-f]{64}', image):
        raise ValueError('LEMO_SANDBOX_IMAGE must be an immutable image digest')
    return ['docker','run','--name',name,'--runtime=runsc','--network=none','--read-only','--user=65534:65534',
            '--cap-drop=ALL','--security-opt=no-new-privileges','--cpus=2','--memory=2g','--memory-swap=2g',
            f'--pids-limit={MAX_PIDS}','--ulimit=nofile=1024:1024','--ulimit=fsize=134217728:134217728',
            '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=384m,mode=1777','--shm-size=64m','--log-driver=none','-i',image]


def kernel_limits(pid, container_id):
    """Read the running sentry's actual host cgroup, not gVisor's virtual /sys.

    gVisor need not expose host cgroup files inside its virtual filesystem.
    Membership and limits are checked in the credential-free executor VM.
    """
    membership=Path(f'/proc/{pid}/cgroup').read_text()
    group=next((line[3:] for line in membership.splitlines() if line.startswith('0::')),None)
    if not group or container_id not in group:raise RuntimeError('Container has no dedicated kernel cgroup')
    root=Path('/sys/fs/cgroup').resolve();path=(root/group.lstrip('/')).resolve()
    if not path.is_relative_to(root) or path==root:raise RuntimeError('Invalid kernel cgroup path')
    if str(pid) not in (path/'cgroup.procs').read_text().split():raise RuntimeError('Container PID is not in the verified cgroup')
    limits={key:(path/key).read_text().strip() for key in ('memory.max','memory.swap.max','cpu.max','pids.max')}
    if limits['memory.max']!='2147483648' or limits['memory.swap.max']!='0' or limits['pids.max']!=str(MAX_PIDS):
        raise RuntimeError('Kernel memory, swap or PID limit does not match the approved quota')
    quota,period=map(int,limits['cpu.max'].split())
    if quota<=0 or period<=0 or quota/period>2:raise RuntimeError('Kernel CPU quota is not enforced')
    return {**limits,'evidence':'host-kernel-cgroup-v2','cgroup':str(path)}


def verify_runtime(image):
    """Fail closed unless a running runsc sentry has real kernel-enforced limits."""
    cmd=command(image,'lemo-probe-'+uuid.uuid4().hex)
    name=cmd[cmd.index('--name')+1]
    cmd.remove('-i')
    cmd=cmd[:-1]+['-d','--entrypoint','node',image,'-e','setInterval(()=>{},1000)']
    try:
        info=subprocess.run(['docker','info','--format','{{json .}}'],capture_output=True,text=True,timeout=10)
        if info.returncode:raise RuntimeError('Docker runtime cannot be inspected')
        host=json.loads(info.stdout);runtime=host.get('Runtimes',{}).get('runsc',{})
        if host.get('CgroupDriver') not in ('cgroupfs','systemd') or str(host.get('CgroupVersion'))!='2' or any(str(a).startswith('--ignore-cgroups') for a in runtime.get('runtimeArgs',[])):
            raise RuntimeError('Docker does not enforce runsc cgroups')
        result=subprocess.run(cmd,capture_output=True,text=True,timeout=25)
        if result.returncode:raise RuntimeError('Runtime start failed: '+result.stderr[-600:])
        container_id=result.stdout.strip()
        if not re.fullmatch('[0-9a-f]{64}',container_id):raise RuntimeError('Invalid runtime container identity')
        state=subprocess.run(['docker','inspect','--format','{{json .State}}',name],capture_output=True,text=True,timeout=10)
        running=json.loads(state.stdout)
        if state.returncode or not running.get('Running') or not isinstance(running.get('Pid'),int) or running['Pid']<=0:
            raise RuntimeError('Runtime probe is not running')
        return kernel_limits(running['Pid'],container_id)
    except Exception as error:
        raise RuntimeError('Runtime resource enforcement is unverified; generated code is blocked: '+str(error)[:700]) from error
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
        if process.returncode or len(output)>MAX_OUTPUT:
            state=subprocess.run(['docker','inspect','--format','{{json .State}}',name],capture_output=True,text=True,timeout=10)
            detail=bytes(errors).decode(errors='replace')[:1600]
            raise RuntimeError(f'Sandbox exited {process.returncode}; state={state.stdout.strip()[:600]}; last_stats={json.dumps(stats[-2:])[:1000]}; {detail}')
        validate_archive(bytes(output))
        return bytes(output),{'wall_seconds':time.monotonic()-start,'docker_stats':stats[-10:],'sample_count':len(stats),'sampled_peak_memory':max(stats,key=lambda s:float(s.get('MemPerc','0%').rstrip('%')),default=None),'sampled_peak_pids':max((int(s.get('PIDs',0)) for s in stats),default=0),'stats_scope':'unverified-host-aggregate' if trusted_fixture else 'container','image':image,'runtime':'runsc','output_bytes':len(output),'trusted_fixture_only':trusted_fixture}
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
