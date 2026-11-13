"""Narrow, credential-free gateway to the real rea-video/Capsule Python APIs."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


def roots():
    root = Path(os.environ.get('MOTION_REVERSE_RUNTIME_ROOT', '/opt/motion-upstreams'))
    return {
        'rea_video': Path(os.environ.get('MOTION_REA_ROOT', str(root / 'rea_video'))),
        'capsule_cinema': Path(os.environ.get('MOTION_CAPSULE_ROOT', str(root / 'capsule_cinema'))),
    }


def runtime_status():
    lock = json.loads(Path(__file__).resolve().parents[1].joinpath('reverse-upstreams.json').read_text())
    result = {'schema': lock['schema'], 'installed': True, 'upstreams': {}}
    for name, path in roots().items():
        python = path / '.venv/bin/python'
        skill = path / lock[name]['skill']
        try:
            commit = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
        except (OSError, subprocess.SubprocessError): commit = None
        ready = bool(python.is_file() and skill.is_file() and commit == lock[name]['commit'])
        result['upstreams'][name] = {'installed': ready, 'commit': commit, 'version': lock[name]['version'], 'license': lock[name]['license']}
        result['installed'] &= ready
    return result


def environment(workspace):
    # Never inherit provider keys, .env paths, account cookies or agent credentials.
    allowed = ('PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
               'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy')
    env = {k: os.environ[k] for k in allowed if k in os.environ}
    env.update(OTEL_SDK_DISABLED='true', CREWAI_TELEMETRY_ENABLED='false', AGNO_TELEMETRY='false',
               DOTENV_PATH=str(Path(workspace) / 'no-provider-credentials.env'),
               PYTHONUNBUFFERED='1', OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
    return env


def decompose(source, output, *, audio=True, ocr=False, asr=False):
    rea = roots()['rea_video']; out = Path(output).resolve()
    if out.exists(): raise ValueError('A new analysis requires a new output directory')
    args = [str(rea / '.venv/bin/rea-video'), 'decompose', str(Path(source).resolve()), '-o', str(out),
            '--no-vlm', '--lang', 'en', '--workers', '2']
    if not audio: args.append('--no-stems')
    if not ocr: args.append('--no-ocr')
    if not asr: args.extend(['--no-asr', '--no-speakers'])
    env = environment(out.parent)
    for name in ('REA_VIDEO_MODELS', 'REA_VIDEO_HOME'):
        if os.environ.get(name): env[name] = os.environ[name]
    result = subprocess.run(args, cwd=rea, env=env, capture_output=True, timeout=2400)
    if result.returncode: raise RuntimeError('rea-video local analysis failed; no AI result was substituted')
    check = subprocess.run([str(rea / '.venv/bin/rea-video'), 'videomd', str(out), '--check'],
                           cwd=rea, env=env, capture_output=True, timeout=60)
    if check.returncode: raise RuntimeError('The upstream VIDEO.md validator rejected the package')
    return {'package': str(out), 'video_md': str(out / 'VIDEO.md'), 'validated': True,
            'analysis': json.loads((out / 'breakdown.json').read_text()), 'semantic_status': 'not_run'}


def capsule_call(operation, payload, output):
    root = roots()['capsule_cinema']; work = Path(output).resolve()
    work.mkdir(parents=True, exist_ok=True)
    runner = Path(__file__).with_name('reverse_capsule_runner.py')
    request = {'operation': operation, 'payload': payload, 'output': str(work), 'runtime': str(root)}
    result = subprocess.run([str(root / '.venv/bin/python'), str(runner)], input=json.dumps(request), text=True,
                            cwd=root, env=environment(work), capture_output=True, timeout=120)
    if result.returncode: raise RuntimeError('Capsule Cinema rejected the recipe or production contract: ' + result.stderr[-500:])
    return json.loads(result.stdout)


def render_videomd(package,analysis):
    rea=roots()['rea_video'];runner=Path(__file__).with_name('reverse_videomd_runner.py')
    result=subprocess.run([str(rea/'.venv/bin/python'),str(runner)],input=json.dumps({'runtime':str(rea),'package':str(package),'analysis':analysis}),text=True,
        cwd=rea,env=environment(package),capture_output=True,timeout=120)
    if result.returncode:raise ValueError('Upstream VIDEO.md rejected the derived observations: '+result.stderr[-400:])
    return json.loads(result.stdout)
