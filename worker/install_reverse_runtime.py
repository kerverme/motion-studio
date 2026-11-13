"""Install pinned REAL upstreams in separate virtualenvs (build-time only).

No provider credentials, startup downloads or generated media. Existing worker
dependencies are untouched. Skills and Apache licenses remain with each source.
"""
import argparse
import json
import subprocess
import os
from pathlib import Path


def install(root):
    manifest = Path(__file__).with_name('reverse-upstreams.json')
    versions = json.loads(manifest.read_text())
    root = Path(root).resolve(); root.mkdir(parents=True, exist_ok=True)
    skills = root / 'skills'; skills.mkdir(exist_ok=True)
    for name in ('rea_video', 'capsule_cinema'):
        spec = versions[name]; source = root / name
        if not source.exists():
            source.mkdir()
            subprocess.run(['git', 'init', '-q', str(source)], check=True)
            subprocess.run(['git', '-C', str(source), 'fetch', '--depth', '1', spec['repository'], spec['commit']], check=True)
            subprocess.run(['git', '-C', str(source), 'checkout', '--detach', 'FETCH_HEAD'], check=True)
        actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != spec['commit']: raise RuntimeError('Upstream commit mismatch: ' + name)
        if not (source / 'LICENSE').is_file(): raise RuntimeError('Upstream license missing: ' + name)
        venv = source / '.venv'
        subprocess.run(['python', '-m', 'venv', str(venv)], check=True)
        python = str(venv / 'bin/python')
        lockfile = Path(__file__).with_name('reverse-' + name + '.lock')
        subprocess.run([python, '-m', 'pip', 'install', '--no-cache-dir', '--no-deps', '-r', str(lockfile)], check=True)
        clean={k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','SSL_CERT_FILE','REQUESTS_CA_BUNDLE','HTTP_PROXY','HTTPS_PROXY','NO_PROXY')}
        clean.update(OTEL_SDK_DISABLED='true',CREWAI_TELEMETRY_ENABLED='false',AGNO_TELEMETRY='false',DOTENV_PATH=str(root/'no-provider-credentials.env'))
        if name == 'rea_video':
            subprocess.run([python, '-m', 'pip', 'install', '--no-deps', str(source)], check=True)
            subprocess.run([str(venv / 'bin/rea-video'), '--help'],env=clean,check=True,stdout=subprocess.DEVNULL)
        else:
            subprocess.run([python, str(source / 'scripts/capsule.py'), '--help'],env=clean,check=True,stdout=subprocess.DEVNULL)
        link = skills / name.replace('_', '-')
        if not link.exists(): link.symlink_to((source / spec['skill']).parent, target_is_directory=True)
    (root / 'installed.json').write_text(json.dumps(versions, indent=2) + '\n')
    return versions


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='/opt/motion-upstreams')
    args = parser.parse_args()
    install(args.root)
