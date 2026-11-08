"""Parallel scene rendering: the episode module is loaded once, then scenes render in forked processes."""
import multiprocessing as mp
import os, subprocess

_MOD = None


def _render_one(args):
    k, out = args
    from engine import render, core
    del core.MISSING_WORDS[:]
    n = render.render_scene(_MOD, k, out)
    return k, n, list(core.MISSING_WORDS)


def render_all(scene_code_path, timeline, end, series_tag, outdir, procs, skip=(), on_progress=None, style='classic'):
    global _MOD
    from engine import render, core
    _MOD = render.load_episode_module(scene_code_path, timeline, end, series_tag, style)
    os.makedirs(outdir, exist_ok=True)
    tasks = []
    for k in range(len(core.ORDER)):
        out = os.path.join(outdir, f'scene_{k:02d}.mp4')
        if k in skip and os.path.exists(out):
            continue
        f0, f1 = render.scene_bounds(k)
        tasks.append((f1 - f0, k, out))
    tasks.sort(reverse=True)  # longest first for better packing
    results, misses = {}, []
    total = sum(n for n, _, _ in tasks) or 1
    ctx = mp.get_context('fork')
    with ctx.Pool(processes=min(procs, max(1, len(tasks)))) as pool:
        for k, n, miss in pool.imap_unordered(_render_one, [(k, out) for _, k, out in tasks]):
            results[k] = n
            misses += miss
            if on_progress:
                try:
                    on_progress(sum(results.values()) / total, len(results), len(tasks))
                except Exception:
                    pass
    files = [os.path.join(outdir, f'scene_{k:02d}.mp4') for k in range(len(core.ORDER))]
    return files, results, sorted(set(map(tuple, misses)))


def concat(files, out):
    lst = out + '.txt'
    with open(lst, 'w') as f:
        for p in files:
            f.write(f"file '{os.path.abspath(p)}'\n")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', out], check=True)
    return out


def mux(video, audio_wav, out):
    tmp = out[:-4] + '.part.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-i', audio_wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp], check=True)
    os.replace(tmp, out)
    return out


def still(scene_code_path, timeline, end, series_tag, t, out, style='classic'):
    from engine import render
    mod = render.load_episode_module(scene_code_path, timeline, end, series_tag, style)
    render.frame(mod, t).save(out)
    return out


def first_frame(video, out):
    """Use the decoded first frame of the delivered MP4, without adding or shifting frames."""
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-map', '0:v:0',
                    '-frames:v', '1', '-update', '1', out], check=True)
    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        raise RuntimeError('delivered video has no first frame')
    return out
