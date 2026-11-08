"""Compile and preview the scene art an LLM wrote for a draft (engine/artkit.py).

check(payload) -> {scenes: [{seg, errors, ms, frames: [jpeg base64]}]}. It runs in a separate process (python -m motion_worker.artcheck,
payload on stdin, result on stdout) so the engine's module-level state never mixes with a running render job and a runaway drawing
can be killed. poll_loop() is the thread in main.py that serves the art_checks table."""
import base64, io, json, os, subprocess, sys, tempfile, threading, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FRAMES = (0.3, 0.88)
THUMB = (288, 512)


def check(payload):
    from PIL import Image, ImageStat
    from motion_worker.preview import fake_timeline, scene_code
    from engine import render, templates, artkit
    script = [{'id': s['id'], 'text': s['text']} for s in payload['script']]
    scenes = [s for s in payload.get('scenes', []) if s.get('type') == 'custom']
    spec = {'opening_frame_cover': payload.get('opening_frame_cover', False), 'strict_art': payload.get('strict_art', False), 'scenes': scenes, 'text': {s['id']: s['text'] for s in script}, 'cast': payload.get('cast') or [], 'art': payload.get('art') or ''}
    out = {'scenes': []}
    tl = fake_timeline(script)
    segs = {s['id']: s for s in tl}
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'scenes.py')
        with open(path, 'w') as f:
            f.write(scene_code(spec))
        mod = render.load_episode_module(path, tl, None, 'check', payload.get('style') or 'classic')
        for sc in scenes:
            seg = sc['seg']
            res = {'seg': seg, 'errors': [], 'frames': [], 'ms': 0}
            if seg not in segs:
                res['errors'].append(f'scene {seg}: no such narration segment')
                out['scenes'].append(res)
                continue
            s = segs[seg]
            t0 = time.time()
            fractions = (0.0,) + FRAMES if payload.get('opening_frame_cover') and seg == script[0]['id'] else FRAMES
            for f in fractions:
                try:
                    t = 0.0 if f == 0.0 else s['s'] + (s['e'] + 0.3 - s['s']) * f
                    # Inspect the artwork itself before badges/subtitles can disguise a blank opener.
                    if f == 0.0:
                        raw = render.scene_frame(mod, seg, 0.0).resize(THUMB).convert('L')
                        if ImageStat.Stat(raw).stddev[0] < 6:
                            res['errors'].append('opening frame is almost blank: show the subject and headline at t=0 without an entrance delay')
                    im = render.frame(mod, t).convert('RGB')
                except Exception as e:   # the engine never raises for scene art (it falls back); anything here is a real problem
                    res['errors'].append(f'render failed: {type(e).__name__}: {e}')
                    break
                small = im.resize(THUMB)
                if f == FRAMES[0] and ImageStat.Stat(small.convert('L')).stddev[0] < 6:
                    res['errors'].append('the frame is almost blank: draw the scene (c.grad for the sky/wall first, then the subject)')
                b = io.BytesIO(); small.save(b, 'JPEG', quality=62)
                res['frames'].append(base64.b64encode(b.getvalue()).decode())
            res['ms'] = int((time.time() - t0) * 1000 / max(1, len(fractions)))
            res['errors'] += [e[1] for e in templates.ERRORS if e[0] == seg]
            if res['ms'] > 1800:
                res['errors'].append(f'drawing is slow ({res["ms"]} ms per frame); use fewer shapes or smaller loops')
            out['scenes'].append(res)
    return out


def poll_loop(stop):
    from motion_worker.db import DB
    db = DB()
    last_clean = 0.0
    while not stop():
        try:
            row = db.one("""UPDATE art_checks SET status='running' WHERE id = (SELECT id FROM art_checks WHERE status='pending'
                            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, payload""")
            if not row:
                if time.time() - last_clean > 3600:
                    db.q("DELETE FROM art_checks WHERE created_at < now() - interval '2 days'")
                    last_clean = time.time()
                time.sleep(1.5)
                continue
            try:
                p = subprocess.run([sys.executable, '-m', 'motion_worker.artcheck'], input=json.dumps(row['payload']), capture_output=True, text=True, timeout=120,
                                   cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                res = json.loads(p.stdout.strip().splitlines()[-1]) if p.returncode == 0 and p.stdout.strip() else {'error': (p.stderr or 'no output')[-400:]}
            except subprocess.TimeoutExpired:
                res = {'error': 'preview timed out (a scene is too heavy to draw)'}
            db.q("UPDATE art_checks SET status=%s, result=%s, finished_at=now() WHERE id=%s", ('error' if 'error' in res else 'done', json.dumps(res), row['id']))
        except Exception as e:
            print('art check error', e, flush=True)
            time.sleep(5)


if __name__ == '__main__':
    try:
        print(json.dumps(check(json.loads(sys.stdin.read()))))
    except Exception as e:
        print(json.dumps({'error': f'{type(e).__name__}: {e}'}))
