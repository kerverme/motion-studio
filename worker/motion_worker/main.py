"""motion-worker: claims jobs from Postgres (SKIP LOCKED), runs the resumable pipeline, survives restarts."""
import json, os, signal, subprocess, sys, time, traceback
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from motion_worker import config, eleven, pipeline, testpkg, audio, drive as drive_mod
from motion_worker.db import DB, Heartbeat
from motion_worker.storage import get_storage

STOP = False


def _sig(*_):
    global STOP
    STOP = True


def run_test_tts(ctx):
    a, al, meta = eleven.tts_with_timestamps(testpkg.TTS_TEXT, config.DEFAULT_VOICE_ID)
    mp3 = ctx.path('test_tts.mp3'); open(mp3, 'wb').write(a)
    alp = ctx.path('test_tts_alignment.json'); json.dump(al, open(alp, 'w'), ensure_ascii=False)
    info = audio.ffprobe(mp3)
    x = audio.decode(mp3)  # proves ffmpeg can read and process it
    wav = audio.write_wav(ctx.path('test_tts.wav'), x)
    k1 = ctx.save('narration', mp3, f'{ctx.prefix}/test_tts.mp3', 'audio/mpeg')
    k2 = ctx.save('alignment', alp, f'{ctx.prefix}/test_tts_alignment.json', 'application/json')
    ctx.db.add_credits(ctx.job, meta.get('character_cost') or len(testpkg.TTS_TEXT))
    # read back from storage to prove durability
    back = ctx.store.get_file(k1, ctx.path('readback.mp3'))
    return {'mp3_key': k1, 'alignment_key': k2, 'duration': float(info['format']['duration']), 'codec': info['streams'][0]['codec_name'],
            'samples_decoded': int(len(x)), 'chars_aligned': len(al['characters']), 'model_id': meta.get('model_id'),
            'storage_readback_bytes': os.path.getsize(back)}


def run_test_drive(ctx):
    src = ctx.db.one("SELECT stage_results FROM jobs WHERE kind='test_render' AND status='READY_TO_POST' ORDER BY finished_at DESC LIMIT 1")
    if not src:
        raise RuntimeError('no completed test_render job to upload')
    key = src['stage_results']['QUALITY_CHECK']['final_key']
    mp4 = ctx.fetch(key, ctx.path('test.mp4'))
    d = drive_mod.Drive()
    root = d.folder(config.DRIVE_ROOT)
    tests = d.folder('_tests', root['id'])
    m = d.upload(mp4, f"test_render_{time.strftime('%Y%m%d_%H%M%S')}.mp4", tests['id'], 'video/mp4')
    return {'drive_file_id': m['id'], 'link': m.get('webViewLink'), 'bytes': int(m['size']), 'md5': m['md5Checksum'], 'verified': m['verified']}


def handle(db, store, job):
    if isinstance(job['package'], str):
        job['package'] = json.loads(job['package'])
    job['stage_results'] = job.get('stage_results') or {}
    kind = job['kind']
    if kind == 'test_render' and not job['package']:
        job['package'] = testpkg.PACKAGE
        db.q('UPDATE jobs SET package=%s WHERE id=%s', (json.dumps(testpkg.PACKAGE, ensure_ascii=False), job['id']))
    ctx = pipeline.Ctx(db, store, job)
    if kind == 'episode':
        return pipeline.run_episode(ctx, config.WORKER_ID)
    if kind == 'test_render':
        if job['status'] == 'NEW':
            db.status(job, 'GENERATING_AUDIO', 'GENERATING_AUDIO', 0, 'test render started')
        for st in ['GENERATING_AUDIO', 'BUILDING_TIMELINE', 'RENDERING', 'QUALITY_CHECK']:
            if st in ctx.r:
                continue
            db.status(job, st, st, None, f'{st} started')
            res = pipeline.STAGES[st](ctx)
            db.save_stage(job, st, res)
        res = {'final_key': ctx.r['QUALITY_CHECK']['final_key'], 'qa_ok': True}
    else:
        fn = {'test_tts': run_test_tts, 'test_drive': run_test_drive}[kind]
        db.status(job, 'RUNNING', kind, 0.1, f'{kind} started')
        res = fn(ctx)
    db.q('UPDATE jobs SET result=%s, locked_by=NULL, locked_until=NULL, error=NULL WHERE id=%s', (json.dumps(res, ensure_ascii=False), job['id']))
    db.status(job, 'READY_TO_POST', kind, 1.0, f'{kind} passed', res)
    return res


def main():
    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)
    print(f'motion-worker {config.WORKER_ID} starting; render procs={config.RENDER_PROCS}', flush=True)
    for tool in (['ffmpeg', '-version'], ['ffprobe', '-version']):
        subprocess.run(tool, capture_output=True, check=True)
    db = DB()
    store = get_storage()
    print('db + storage ready', flush=True)
    while not STOP:
        job = None
        try:
            job = db.claim(config.WORKER_ID)
        except Exception as e:
            print('claim error', e, flush=True)
            time.sleep(10)
            continue
        if not job:
            time.sleep(config.POLL_SECONDS)
            continue
        print(f"claimed job {job['id']} kind={job['kind']} status={job['status']} attempt={job['attempts']}", flush=True)
        hb = Heartbeat(db, job['id'], config.WORKER_ID)
        hb.start()
        try:
            handle(db, store, job)
            print(f"job {job['id']} done", flush=True)
        except pipeline.BudgetExceeded as e:
            db.fail(job, str(e), final=True)
        except Exception as e:
            tb = traceback.format_exc()
            print(tb, flush=True)
            final = job['attempts'] >= job['max_attempts'] or isinstance(e, (eleven.ElevenError,)) and 'HTTP 4' in str(e) and '429' not in str(e)
            db.fail(job, f'{type(e).__name__}: {e}', final=final)
        finally:
            hb.stop.set()


if __name__ == '__main__':
    main()
