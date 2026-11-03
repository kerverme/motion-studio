#!/usr/bin/env python3
"""Claude-side client for the Motion Studio API.
  motion.py submit episodes/ep002-tum/package.json   -> queue an episode
  motion.py test test_tts|test_render|test_drive      -> queue an acceptance test
  motion.py status <job_id> [--wait]                  -> show / follow progress
Needs MOTION_API_URL and MOTION_API_TOKEN in the environment."""
import json, os, sys, time, urllib.request

URL = os.environ.get('MOTION_API_URL', 'https://motion-api-production-8f76.up.railway.app').rstrip('/')
TOK = os.environ.get('MOTION_API_TOKEN', '')


def call(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
                                 headers={'authorization': f'Bearer {TOK}', 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {'http_error': e.code, 'body': e.read().decode()[:2000]}


def follow(job_id):
    last = None
    while True:
        s = call('GET', f'/jobs/{job_id}/status')
        line = f"{s.get('status')} {s.get('stage')} {round((s.get('progress') or 0) * 100)}% credits={s.get('used_credits')}"
        if line != last:
            print(time.strftime('%H:%M:%S'), line, flush=True)
            last = line
        if s.get('status') in ('READY_TO_POST', 'FAILED', 'CANCELLED') or 'http_error' in s:
            print(json.dumps(s, ensure_ascii=False, indent=1)[:4000])
            return s
        time.sleep(15)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'submit':
        pkg = json.load(open(sys.argv[2], encoding='utf-8'))
        print(json.dumps(call('POST', '/jobs', {'kind': 'episode', 'package': pkg}), ensure_ascii=False, indent=1))
    elif cmd == 'test':
        print(json.dumps(call('POST', '/jobs', {'kind': sys.argv[2], 'force': True}), ensure_ascii=False, indent=1))
    elif cmd == 'status':
        follow(sys.argv[2]) if '--wait' in sys.argv else print(json.dumps(call('GET', f'/jobs/{sys.argv[2]}/status'), ensure_ascii=False, indent=1))
    elif cmd == 'health':
        print(json.dumps(call('GET', '/health'), indent=1))
