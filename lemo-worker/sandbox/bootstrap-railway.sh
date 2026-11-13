#!/bin/sh
# Run only in a newly created, credential-free Railway Sandbox.
# Upload the allowlisted renderer context to /tmp/lemo-renderer-context.tar first.
set -eu
mkdir -p /opt/lemo /etc/docker /usr/local/lib/docker/cli-plugins
curl -fsSL https://storage.googleapis.com/gvisor/releases/release/20260413.0/x86_64/runsc -o /usr/local/bin/runsc
curl -fsSL https://github.com/docker/buildx/releases/download/v0.29.1/buildx-v0.29.1.linux-amd64 -o /usr/local/lib/docker/cli-plugins/docker-buildx
python3 - <<'PY'
import hashlib,json,os,signal
from pathlib import Path
for path,expected in [('/usr/local/bin/runsc','c97966a7bce00a6ce6de2f931b2b4cf0cbe979d5f47d9feda75f5bbbce0d93ad'),('/usr/local/lib/docker/cli-plugins/docker-buildx','7d2d7d6d4680aa349614965aaa33ccec43f1a9a21e908a5ce4cb6adfa5ad5141')]:
    p=Path(path)
    if hashlib.sha256(p.read_bytes()).hexdigest()!=expected:raise RuntimeError('Pinned binary checksum mismatch')
    p.chmod(0o755)
p=Path('/etc/docker/daemon.json')
config=json.loads(p.read_text()) if p.exists() else {}
config.setdefault('runtimes',{})['runsc']={'path':'/usr/local/bin/runsc','runtimeArgs':['--platform=ptrace']}
p.write_text(json.dumps(config))
for proc in Path('/proc').iterdir():
    if proc.name.isdigit():
        try:
            if (proc/'comm').read_text().strip()=='dockerd':os.kill(int(proc.name),signal.SIGHUP)
        except (FileNotFoundError,PermissionError):pass
PY
tar -xf /tmp/lemo-renderer-context.tar -C /opt/lemo
DOCKER_BUILDKIT=1 docker build -f /opt/lemo/sandbox/Dockerfile -t cloudbath-lemo-renderer:verified /opt/lemo > /tmp/lemo-image-build.log 2>&1
docker image inspect cloudbath-lemo-renderer:verified --format '{{.Id}}' > /opt/lemo/image-id.txt
python3 /opt/lemo/sandbox/railway_job.py ready
python3 /opt/lemo/sandbox/security_probe.py
