"""Stage-level resumable production pipeline. Each stage stores its outputs in jobs.stage_results and in the bucket,
so a crash or redeploy resumes from the last completed stage without paying for audio twice."""
import datetime as dt, hashlib, json, os, re, shutil, tarfile, zoneinfo
from . import audio, config, drive as drive_mod, r2 as r2_mod, eleven, qa, rendering, timeline as tl
from .storage import sha256_file

ORDER = ['GENERATING_AUDIO', 'BUILDING_TIMELINE', 'RENDERING', 'QUALITY_CHECK', 'UPLOADING_DRIVE', 'READY_TO_POST']
ENGINE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'engine')


class BudgetExceeded(RuntimeError):
    pass


class Ctx:
    def __init__(self, db, store, job):
        self.db, self.store, self.job = db, store, job
        self.pkg = job['package']
        self.dir = os.path.join(config.WORKDIR, str(job['id']))
        os.makedirs(self.dir, exist_ok=True)
        self.prefix = f"jobs/{job['id']}"
        self.r = job['stage_results']

    def path(self, *p):
        q = os.path.join(self.dir, *p)
        os.makedirs(os.path.dirname(q), exist_ok=True)
        return q

    def fetch(self, key, local):
        if not os.path.exists(local):
            self.store.get_file(key, local)
        return local

    def save(self, kind, local, key=None, ctype=None, meta=None):
        key = key or f'{self.prefix}/{os.path.basename(local)}'
        self.store.put_file(key, local, ctype)
        self.db.asset(self.job, kind, key, os.path.getsize(local), sha256_file(local), meta)
        return key

    def spend_check(self, credits_needed):
        used = float(self.job.get('used_credits') or 0)
        budget = min(int(self.job['budget_credits']), config.MAX_CREDITS)
        if used + credits_needed > budget:
            raise BudgetExceeded(f'budget cap reached: used {used:.0f} + next {credits_needed:.0f} > {budget} credits (not bypassed)')


def cached_audio(ctx, kind, payload, est_credits, gen, ext='mp3'):
    """Generate audio once per unique request; reuse from the bucket afterwards."""
    key = eleven.cache_key(kind, payload)
    hit = ctx.db.cache_get(key)
    if hit and ctx.store.exists(hit['storage_key']):
        return hit['storage_key'], hit['meta'], 0.0, True
    ctx.spend_check(est_credits)
    data, meta = gen()
    skey = f"cache/{kind}/{key.split(':')[1]}.{ext}"
    ctx.store.put_bytes(skey, data, 'audio/mpeg')
    credits = meta.get('character_cost') or est_credits
    ctx.db.cache_put(key, kind, skey, credits, meta)
    ctx.db.add_credits(ctx.job, credits)
    return skey, meta, credits, False


def default_music_key(ctx):
    """The channel's default music (owner's choice, stored in integrations 'default_music': the track of a finished episode,
    EP002 'คนชื่อตั้ม' unless changed in the studio). Reused as-is, so no music credits are spent. None if it cannot be found."""
    try:
        cfg = ctx.db.one("SELECT data FROM integrations WHERE provider='default_music'")
        ep = int(((cfg or {}).get('data') or {}).get('episode') or 0)
        row = ctx.db.one("""SELECT j.stage_results->'GENERATING_AUDIO'->>'music_key' AS k FROM jobs j JOIN episodes e ON e.id = j.episode_id
                            WHERE e.number = %s AND j.stage_results->'GENERATING_AUDIO'->>'music_key' IS NOT NULL
                            ORDER BY j.finished_at DESC NULLS LAST LIMIT 1""", (ep,)) if ep else None
        key = row and row.get('k')
        if key and ctx.store.exists(key):
            ctx.db.event(ctx.job['id'], f'ใช้เพลงเริ่มต้นของช่อง (เพลงจาก EP{ep:03d})', {'music_key': key}, status='GENERATING_AUDIO')
            return key
        ctx.db.event(ctx.job['id'], f'หาเพลงเริ่มต้น (EP{ep:03d}) ไม่เจอ จึงให้ AI แต่งเพลงตามเรื่องแทน', None, 'warn', 'GENERATING_AUDIO')
    except Exception as e:  # never fail a clip over the default track
        ctx.db.event(ctx.job['id'], f'อ่านเพลงเริ่มต้นไม่ได้ ({e!r}) จึงให้ AI แต่งเพลงแทน', None, 'warn', 'GENERATING_AUDIO')
    return None


# ---------------------------------------------------------------- stages
def stage_audio(ctx):
    if ctx.pkg.get('creative'):
        from .creative_audio import stage_audio as approved_audio
        return approved_audio(ctx)
    p = ctx.pkg
    v = p['voice']
    segs = p['script']
    text = ' '.join(s['text'] for s in segs)
    # narration (+ alignment) — one request when it fits, otherwise per segment with continuity hints
    tts_payload = {'text': text, 'voice': v}
    key = eleven.cache_key('tts', tts_payload)
    hit = ctx.db.cache_get(key)
    vo_local, al_local = ctx.path('audio', 'narration.mp3'), ctx.path('audio', 'alignment.json')
    if hit and ctx.store.exists(hit['storage_key']):
        ctx.fetch(hit['storage_key'], vo_local)
        ctx.fetch(hit['meta']['alignment_key'], al_local)
        meta = hit['meta']
    else:
        ctx.spend_check(len(text) * 1.05)
        chunks = [text] if len(text) <= (2000 if v.get('model_id', 'eleven_v4') == 'eleven_v4' else 4500) else [s['text'] for s in segs]
        parts, chars, starts, ends, offset, metas = [], '', [], [], 0.0, []
        for i, chunk in enumerate(chunks):
            a, al, m = eleven.tts_with_timestamps(chunk, v['voice_id'], v.get('model_id', 'eleven_v4'), v.get('language_code', 'th'),
                                                  v.get('stability', 0.4), v.get('similarity_boost', 0.75),
                                                  previous_text=chunks[i - 1] if i else None, next_text=chunks[i + 1] if i + 1 < len(chunks) else None,
                                                  speed=v.get('speed'))
            pp = ctx.path('audio', f'part_{i:02d}.mp3')
            open(pp, 'wb').write(a)
            c, s, e = tl.flatten_alignment(al, offset)
            if chars:
                chars += ' '
                starts.append(s[0]); ends.append(s[0])
            chars += c; starts += s; ends += e
            offset += audio.duration(pp)
            parts.append(pp); metas.append(m)
        if len(parts) == 1:
            shutil.copyfile(parts[0], vo_local)
        else:
            rendering.concat(parts, vo_local)
        json.dump({'text': chars, 'start': starts, 'end': ends}, open(al_local, 'w'), ensure_ascii=False)
        credits = sum((m.get('character_cost') or 0) for m in metas) or len(text)
        vkey = f"cache/tts/{key.split(':')[1]}.mp3"
        akey = f"cache/tts/{key.split(':')[1]}.alignment.json"
        ctx.store.put_file(vkey, vo_local, 'audio/mpeg')
        ctx.store.put_file(akey, al_local, 'application/json')
        meta = {'alignment_key': akey, 'requests': metas, 'model_id': metas[0].get('model_id')}
        ctx.db.cache_put(key, 'tts', vkey, credits, meta)
        ctx.db.add_credits(ctx.job, credits)
    vo_info = audio.ffprobe(vo_local)  # validates the file decodes
    vo_dur = float(vo_info['format']['duration'])
    ctx.save('narration', vo_local, f'{ctx.prefix}/audio/narration.mp3', 'audio/mpeg', {'duration': vo_dur, 'model_id': meta.get('model_id')})
    ctx.save('alignment', al_local, f'{ctx.prefix}/audio/alignment.json', 'application/json')
    ctx.db.event(ctx.job['id'], f'narration ready ({vo_dur:.1f}s)', {'model_id': meta.get('model_id')}, status='GENERATING_AUDIO')

    sfx = {}
    for fx in p.get('sfx', []):
        payload = {'prompt': fx['prompt'], 'duration': fx['duration']}
        skey, m, cr, reused = cached_audio(ctx, 'sfx', payload, fx['duration'] * 3.4,
                                           lambda fx=fx: eleven.sound_effect(fx['prompt'], fx['duration']))
        sfx[fx['id']] = skey
    music_key = None
    if p.get('music') and p['music'].get('source') == 'default':
        music_key = default_music_key(ctx)
    if p.get('music') and not music_key:
        length_ms = int((vo_dur + 2.5) * 1000)
        payload = {'prompt': p['music']['prompt'], 'length_ms': length_ms, 'model_id': p['music'].get('model_id', 'music_v1')}
        music_key, m, cr, reused = cached_audio(ctx, 'music', payload, (length_ms / 1000) * 15,
                                                lambda: eleven.music(payload['prompt'], length_ms, payload['model_id']))
    ctx.db.event(ctx.job['id'], f'sfx {len(sfx)} + music {"yes" if music_key else "no"} ready', None, status='GENERATING_AUDIO')
    return {'narration_key': f'{ctx.prefix}/audio/narration.mp3', 'alignment_key': f'{ctx.prefix}/audio/alignment.json',
            'narration_duration': vo_dur, 'sfx': sfx, 'music_key': music_key}


def stage_timeline(ctx):
    a = ctx.r['GENERATING_AUDIO']
    al = json.load(open(ctx.fetch(a['alignment_key'], ctx.path('audio', 'alignment.json'))))
    timeline = tl.build_timeline(ctx.pkg['script'], al['text'], al['start'], al['end'])
    end = round(max(a['narration_duration'], timeline[-1]['e']) + 1.8, 2)
    cues, misses = tl.resolve_cues(timeline, ctx.pkg.get('sfx', []))
    if ctx.pkg.get('creative') and misses:
        raise RuntimeError('Sound anchors could not be resolved; fix only these cues: '+json.dumps(misses,ensure_ascii=False))
    data = {'timeline': timeline, 'end': end, 'cues': cues, 'cue_misses': misses}
    lp = ctx.path('timeline.json')
    json.dump(data, open(lp, 'w'), ensure_ascii=False, indent=1)
    key = ctx.save('timeline', lp, f'{ctx.prefix}/timeline.json', 'application/json')
    if ctx.job.get('episode_id'):
        for s in timeline:
            ctx.db.q('UPDATE scenes SET start_s=%s, end_s=%s WHERE episode_id=%s AND seg_id=%s', (s['s'], s['e'], ctx.job['episode_id'], s['id']))
    return {'timeline_key': key, 'end': end, 'segments': len(timeline), 'cue_misses': misses}


def load_timeline(ctx):
    return json.load(open(ctx.fetch(ctx.r['BUILDING_TIMELINE']['timeline_key'], ctx.path('timeline.json'))))


def write_scene_code(ctx):
    p = ctx.path('scenes.py')
    open(p, 'w').write(ctx.pkg['scene_code'])
    return p


def do_mix(ctx, T, gains_scale=None, trim_db=0.0):
    a = ctx.r['GENERATING_AUDIO']
    vo = ctx.fetch(a['narration_key'], ctx.path('audio', 'narration.mp3'))
    sfx_files = {k: ctx.fetch(v, ctx.path('audio', 'sfx', f'{k}.mp3')) for k, v in a['sfx'].items()}
    mus = ctx.fetch(a['music_key'], ctx.path('audio', 'music.mp3')) if a.get('music_key') else None
    cues = [dict(c) for c in T['cues']]
    if gains_scale:
        for c in cues:
            c['gain'] = round(c['gain'] * gains_scale.get(f"{c['sfx']}@{c['t']}", 1.0), 3)
    mvol = (ctx.pkg.get('music') or {}).get('volume', 0.3)
    mixed, stems = audio.mix(vo, T['end'], sfx_files, cues, mus, mvol, duck_sfx=bool(ctx.pkg.get('creative')))
    raw = audio.write_wav(ctx.path('audio', 'mix_raw.wav'), mixed)
    fin = audio.finish(raw, ctx.path('audio', 'mix.wav'), trim_db=trim_db)
    return fin, stems, cues, sfx_files


def stage_render(ctx):
    if not ctx.pkg.get('creative'):
        return _stage_render(ctx)
    from .creative_ledger import Ledger, digest
    import time
    def render_approved(_reservation):
        started = time.monotonic()
        result = _stage_render(ctx)
        return {**result, 'usage': {'wall_seconds': time.monotonic() - started}, 'asset_keys': [result['final_key'], result['silent_key']]}
    return Ledger(ctx).execute('classic-render-v1', 'infrastructure', 'classic', 'compute',
                               {'scene_code': digest(ctx.pkg['scene_code']), 'timeline': ctx.r['BUILDING_TIMELINE']},
                               ctx.pkg['creative']['allocations']['compute'], render_approved)


def _stage_render(ctx):
    T = load_timeline(ctx)
    code = write_scene_code(ctx)
    lo, hi = PROGRESS['BUILDING_TIMELINE'], PROGRESS['RENDERING']

    def _prog(f, done, n):
        ctx.db.q('UPDATE jobs SET progress=%s, updated_at=now() WHERE id=%s', (round(lo + (hi - lo) * 0.9 * f, 3), ctx.job['id']))
        ctx.db.event(ctx.job['id'], f'เรนเดอร์เสร็จ {done}/{n} ฉาก ({round(f * 100)}% ของเฟรม)', None, 'info', 'RENDERING')
    ctx.db.event(ctx.job['id'], 'เริ่มเรนเดอร์ภาพ (วาดด้วยโค้ด ไม่ใช้ LLM)', None, 'info', 'RENDERING')
    style = ctx.pkg.get('style') or 'classic'
    if style != 'classic':
        ctx.db.event(ctx.job['id'], f'สไตล์ภาพ: {style}', None, 'info', 'RENDERING')
    files, frames, misses = rendering.render_all(code, T['timeline'], T['end'], ctx.pkg.get('series_tag'), ctx.path('scenes'), config.RENDER_PROCS,
                                                 on_progress=_prog, style=style)
    silent = rendering.concat(files, ctx.path('video_silent.mp4'))
    mixwav, stems, cues, _ = do_mix(ctx, T)
    final = rendering.mux(silent, mixwav, ctx.path('final.mp4'))
    ctx.save('video_silent', silent, f'{ctx.prefix}/render/video_silent.mp4', 'video/mp4')
    ctx.save('mix', mixwav, f'{ctx.prefix}/render/mix.wav', 'audio/wav')
    key = ctx.save('video', final, f'{ctx.prefix}/render/final.mp4', 'video/mp4')
    return {'final_key': key, 'silent_key': f'{ctx.prefix}/render/video_silent.mp4', 'missing_words': [list(m) for m in misses],
            'frames': sum(frames.values())}


def stage_qa(ctx):
    T = load_timeline(ctx)
    R = ctx.r['RENDERING']
    a = ctx.r['GENERATING_AUDIO']
    final = ctx.fetch(R['final_key'], ctx.path('final.mp4'))
    silent = ctx.fetch(R['silent_key'], ctx.path('video_silent.mp4'))
    scale, trim = {}, 0.0
    for attempt in range(3):
        ctx.db.event(ctx.job['id'], f'ตรวจคุณภาพ รอบที่ {attempt + 1}/3 (มิกซ์เสียง + ตรวจภาพ/เสียง)', None, 'info', 'QUALITY_CHECK')
        mixwav, stems, cues, sfx_files = do_mix(ctx, T, scale, trim)
        final = rendering.mux(silent, mixwav, ctx.path('final.mp4'))  # always remux: picks up mastering fixes without re-rendering video
        durs = {k: audio.duration(p) for k, p in sfx_files.items()}
        rep = qa.run(final, T['end'], T['timeline'], stems, cues, durs, R.get('missing_words', []), ctx.pkg, T.get('cue_misses', []))
        bad = [c['name'] for c in rep['checks'] if c['hard'] and not c['ok']]
        ctx.db.event(ctx.job['id'], 'ผลตรวจรอบที่ %d: %s' % (attempt + 1, 'ผ่าน' if rep['ok'] else 'ยังไม่ผ่าน (' + ', '.join(bad) + ')'), None,
                     'info' if rep['ok'] else 'warn', 'QUALITY_CHECK')
        if rep['ok']:
            break
        fixable = False
        clip = next((c for c in rep['checks'] if c['name'] == 'no_clipping' and not c['ok']), None)
        if clip:  # master too hot: trim the whole mix so the peak lands at about -1.5 dBFS
            trim -= max(1.0, (clip['detail'] or {}).get('peak_dbfs', 0) + 1.5)
            fixable = True
        for c in rep['loud_cues']:  # pull loud SFX down under the narration
            k = f"{c['sfx']}@{c['t']}"
            over = c['sfx_db'] - c['vo_db'] + 3
            scale[k] = scale.get(k, 1.0) * (10 ** (-over / 20))
            fixable = True
        if not fixable:
            break
        ctx.db.event(ctx.job['id'], f'QA ซ่อมเสียง: ลดเอฟเฟกต์ {len(rep["loud_cues"])} จุด, ลดมาสเตอร์รวม {trim:.1f} dB แล้วมิกซ์ใหม่', None, 'warn', 'QUALITY_CHECK')
    rep['repairs'] = len(scale)
    ctx.db.q('UPDATE jobs SET qa_report=%s WHERE id=%s', (json.dumps(rep), ctx.job['id']))
    if not rep['ok']:
        failed = [c['name'] for c in rep['checks'] if c['hard'] and not c['ok']]
        raise RuntimeError('QA failed: ' + ', '.join(failed))
    key = ctx.save('video', final, f'{ctx.prefix}/render/final_qa.mp4', 'video/mp4', {'qa': 'passed'})
    return {'final_key': key, 'qa_ok': True}


# ---------------------------------------------------------------- deliverables
def slug_th(s):
    s = re.sub(r'[\\/:*?"<>|\n\r\t]+', ' ', s).strip()
    return re.sub(r'\s+', '_', s)[:60]


def make_cover(ctx, number, out):
    """Owner's rule: every clip has a cover reading "คนนี้ชื่อ “NAME”" with the main character (cast[0]) and a hook line below."""
    import math
    from PIL import Image, ImageDraw
    from engine import core, templates
    from engine.characters import draw_person
    cv = ctx.pkg['cover']
    name = str(cv['name']).strip()[:20]
    cast = {c['name']: c for c in (ctx.pkg.get('spec') or {}).get('cast', []) if isinstance(c, dict) and c.get('name')}
    if not cast:   # the spec lives inside the generated scene code, so recover the cast from there
        import re, json as _j
        m = re.search(r'SPEC = json\.loads\((.*)\)\nSCENES', ctx.pkg.get('scene_code', ''), re.S)
        if m:
            try:
                cast = {c['name']: c for c in _j.loads(_j.loads(m.group(1))).get('cast', []) if isinstance(c, dict) and c.get('name')}
            except Exception:
                cast = {}
    templates.CAST.clear(); templates.CAST.update(cast)
    style = templates.person_style({'who': cv['who']}) if cv['who'] in cast else {}
    top, bot = templates.PALETTES[templates.PAL_ORDER[(int(number) * 5 + sum(map(ord, name))) % len(templates.PAL_ORDER)]]
    img = core.gradient(top, bot).copy()
    bd = templates.photo_backdrop(cast[cv['who']].get('backdrop')) if cv['who'] in cast and cast[cv['who']].get('backdrop') else None
    if bd is not None:   # the background of the uploaded photo (person already erased), flattened by code
        img.alpha_composite(bd.crop(((bd.width - 1080) // 2, (bd.height - 1920) // 2, (bd.width - 1080) // 2 + 1080, (bd.height - 1920) // 2 + 1920)))
    d = ImageDraw.Draw(img, 'RGBA')
    # rays behind the character
    cx, cy = 540, 1060
    lay = Image.new('RGBA', img.size, (0, 0, 0, 0))     # translucent shapes go on their own layer: ImageDraw on RGBA overwrites instead of blending
    ld = ImageDraw.Draw(lay)
    for k in range(18):
        a0 = k * 20 * math.pi / 180
        ld.polygon([(cx, cy), (cx + 1500 * math.cos(a0), cy + 1500 * math.sin(a0)), (cx + 1500 * math.cos(a0 + 0.17), cy + 1500 * math.sin(a0 + 0.17))], fill=(255, 255, 255, 30))
    ld.ellipse((cx - 400, cy - 400, cx + 400, cy + 400), fill=(255, 255, 255, 45))
    img.alpha_composite(lay)
    # the character on its own layer, then the clip's visual style on the picture (text stays crisp on top)
    chars = Image.new('RGBA', img.size, (0, 0, 0, 0))
    draw_person(chars, 540, 995, 335, 0.6, style=style, pose='stand', mood='happy', wave=1.0, talk=0.0)
    from engine import styles
    img = styles.apply(ctx.pkg.get('style') or 'classic', img, chars, 0.0)
    d = ImageDraw.Draw(img, 'RGBA')
    core.series_tag(img, d)
    tag = core.text_img(f'EP{number:03d}', 56, 900, (30, 20, 60), 0)
    d.rounded_rectangle((40, 120, 80 + tag.width, 140 + tag.height + 20), 24, fill=(255, 225, 60, 255))
    core.comp(img, tag, 60, 140)
    # "คนนี้ชื่อ"
    t1 = core.text_img('คนนี้ชื่อ', 150, 900, (255, 255, 255), 10, (30, 20, 60))
    core.comp(img, t1, 540 - t1.width / 2, 250)
    # the name on a sticker, as large as fits
    size = 260
    while size > 90 and core.F(size, 900).getlength('“' + name + '”') > 900:
        size -= 10
    t2 = core.text_img('“' + name + '”', size, 900, (30, 20, 60), 0)
    w, h = t2.width + 90, t2.height + 50
    card = Image.new('RGBA', (w + 40, h + 40), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle((26, 30, w + 26, h + 30), 44, fill=(20, 12, 30, 150))
    cd.rounded_rectangle((20, 20, w + 14, h + 14), 44, fill=(255, 225, 60, 255), outline=(255, 255, 255, 255), width=8)
    card.alpha_composite(t2, (20 + (w - t2.width) // 2 - 6, 20 + (h - t2.height) // 2))
    card = card.rotate(-3, resample=Image.BICUBIC, expand=True)
    core.comp(img, card, 540 - card.width / 2, 430)
    band = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(band).rectangle((0, 1580, 1080, 1920), fill=(20, 12, 30, 235))
    img.alpha_composite(band)
    # bottom hook line
    line = (cv.get('line') or ctx.pkg['title_th']).strip()
    f = core.F(84, 900)
    words, lines, cur = line.split(' '), [], ''
    for wd in words:
        cand = (cur + ' ' + wd).strip()
        if f.getlength(cand) > 960 and cur:
            lines.append(cur); cur = wd
        else:
            cur = cand
    lines.append(cur)
    y = 1580 + (340 - 110 * len(lines[:3])) // 2 - 6
    for ln in lines[:3]:
        im = core.text_img(ln, 84, 900, (255, 225, 60), 8, (30, 20, 60))
        core.comp(img, im, 540 - im.width / 2, y)
        y += 110
    img.convert('RGB').save(out)
    return out


def make_thumbnail(ctx, T, number, out, video=None):
    from engine.artkit import ArtError
    from PIL import ImageDraw
    from engine import core, render
    if (ctx.pkg.get('thumbnail') or {}).get('mode') == 'opening_frame':
        if not video:
            raise ValueError('opening-frame cover requires the delivered video')
        return rendering.first_frame(video, out)
    if ctx.pkg.get('cover'):
        try:
            return make_cover(ctx, number, out)
        except ArtError:
            raise  # bespoke portrait failures must not silently become a generic thumbnail
        except Exception as e:   # a cover problem must never fail the clip: fall back to the scene-frame thumbnail
            print(f'[thumbnail] cover failed, using the scene frame: {e!r}', flush=True)
    code = write_scene_code(ctx)
    mod = render.load_episode_module(code, T['timeline'], T['end'], ctx.pkg.get('series_tag'), ctx.pkg.get('style') or 'classic')
    th = ctx.pkg.get('thumbnail') or {'seg': T['timeline'][0]['id'], 'offset': 2.0}
    seg = next(s for s in T['timeline'] if s['id'] == th['seg'])
    t = min(seg['e'], seg['s'] + th.get('offset', 2.0))
    img = render.scene_frame(mod, th['seg'], t)
    d = ImageDraw.Draw(img, 'RGBA')
    title = th.get('title') or ctx.pkg['title_th']
    d.rectangle((0, 1380, 1080, 1920), fill=(20, 12, 30, 215))
    f = core.F(84, 900)
    words, lines, cur = title.split(' '), [], ''
    for w in words:
        cand = (cur + ' ' + w).strip()
        if f.getlength(cand) > 960 and cur:
            lines.append(cur); cur = w
        else:
            cur = cand
    lines.append(cur)
    y = 1440
    for ln in lines[:3]:
        im = core.text_img(ln, 84, 900, (255, 225, 60), 8, (30, 20, 60))
        core.comp(img, im, 540 - im.width / 2, y)
        y += 110
    tag = core.text_img(f'EP{number:03d}', 56, 900, (30, 20, 60), 0)
    d.rounded_rectangle((40, 120, 80 + tag.width, 140 + tag.height + 20), 24, fill=(255, 225, 60, 255))
    core.comp(img, tag, 60, 140)
    core.series_tag(img, d)
    img.convert('RGB').save(out)
    return out


def write_docs(ctx, T, number, folder):
    p = ctx.pkg
    files = {}
    seg_t = {s['id']: s for s in T['timeline']}
    # script
    lines = [f"EP{number:03d} — {p['title_th']}", f"หัวข้อ: {p['topic']}", '']
    for s in p['script']:
        tt = seg_t.get(s['id'])
        lines.append(f"[{s['id']}] {tt['s']:.1f}–{tt['e']:.1f}s" if tt else f"[{s['id']}]")
        lines.append(s['text']); lines.append('')
    files['script.txt'] = '\n'.join(lines)
    # captions
    cap = p.get('captions', {})
    cl = [f"# Captions — EP{number:03d} {p['title_th']}", '']
    for k, label in (('facebook', 'Facebook Reels'), ('instagram', 'Instagram Reels'), ('tiktok', 'TikTok'), ('youtube', 'YouTube Shorts')):
        cl += [f'## {label}', cap.get(k, cap.get('default', '')), '']
    files['captions.md'] = '\n'.join(cl)
    files['subtitles.srt'] = tl.srt(T['timeline'], T['end'])
    # research manifest
    files['sources.json'] = json.dumps({'sources': p.get('sources', []), 'claims': p.get('claims', [])}, ensure_ascii=False, indent=2)
    # storyboard with actual timings
    sb = {b.get('seg'): b for b in p.get('storyboard', [])}
    st = [f"# Storyboard — EP{number:03d} {p['title_th']}", '']
    for s in p['script']:
        tt = seg_t.get(s['id'], {})
        b = sb.get(s['id'], {})
        st.append(f"## {s['id']}  ({tt.get('s', 0):.2f}s → {tt.get('e', 0):.2f}s)")
        st.append(f"- Narration: {s['text']}")
        for k in ('visual', 'characters', 'animation', 'onscreen', 'sfx', 'transition'):
            if b.get(k):
                st.append(f'- {k.title()}: {b[k]}')
        st.append('')
    sfx_cues = '\n'.join(f"- {c['t']:.2f}s  {c['sfx']}  gain {c['gain']}" for c in T['cues'])
    st += ['## SFX cue sheet (resolved from narration)', sfx_cues]
    files['storyboard.md'] = '\n'.join(st)
    if p.get('creative'):
        calls = ctx.db.q('SELECT category,model,reserved_usd,actual_usd,status,usage,provider_id FROM creative_calls WHERE job_id=%s', (ctx.job['id'],))
        files['creative-manifest.json'] = json.dumps({'creative': p['creative'], 'storyboard': p['storyboard'], 'audio': ctx.r.get('GENERATING_AUDIO'), 'render': ctx.r.get('LEMO_RENDER'), 'costs': calls}, ensure_ascii=False, indent=2, default=str)
        for name, data in {
            'cost-summary.json': {'calls': calls, 'unreconciled': sum(c.get('actual_usd') is None for c in calls)},
            'style-director.json': p['creative']['selection'],
            'storyboard.json': p['storyboard'],
            'sound-design.json': {'plan': p['creative']['selection']['plan']['scenes'], 'effects': ctx.r.get('GENERATING_AUDIO', {}).get('sfx_manifest', [])},
            'narration-metadata.json': ctx.r.get('GENERATING_AUDIO', {}).get('narration_manifest', []),
            'render-metadata.json': ctx.r.get('LEMO_RENDER', {}),
        }.items():
            files[name] = json.dumps(data, ensure_ascii=False, indent=2, default=str)
    out = {}
    for name, text in files.items():
        pth = os.path.join(folder, name)
        with open(pth, 'w', encoding='utf-8') as file:
            file.write(text)
        out[name] = pth
    return out


def make_archive(ctx, T, out):
    with tarfile.open(out, 'w:gz') as tar:
        info = json.dumps(ctx.pkg, ensure_ascii=False, indent=1).encode()
        p = ctx.path('package.json'); open(p, 'wb').write(info)
        tar.add(p, 'episode/package.json')
        tar.add(write_scene_code(ctx), 'episode/scenes.py')
        tar.add(ctx.path('timeline.json'), 'episode/timeline.json')
        if ctx.pkg.get('text_video'):
            manifest = ctx.path('production_manifest.json')
            json.dump({'shots': ctx.r.get('FAL_SHOTS'), 'approval': ctx.pkg['text_video']['approval']}, open(manifest, 'w'), ensure_ascii=False, indent=2)
            tar.add(manifest, 'episode/production_manifest.json')
        if ctx.pkg.get('creative'):
            manifest = ctx.path('creative-source.json')
            json.dump({'creative':ctx.pkg['creative'],'render':ctx.r.get('LEMO_RENDER',{})},open(manifest,'w'),ensure_ascii=False,default=str)
            tar.add(manifest, 'episode/creative-source.json')
            for i, scene in enumerate(ctx.r.get('LEMO_RENDER',{}).get('scenes',[])):
                source = ctx.fetch(scene['source_key'],ctx.path('sources',f'{i}.html'))
                tar.add(source, f'episode/lemo/scene-{i}.html')
            if ctx.pkg['creative'].get('engine') == 'lemo':
                vendor = os.environ.get('LEMO_VENDOR_DIR') or os.path.abspath(os.path.join(ENGINE_DIR, '..', '..', 'lemo-worker', 'vendor', 'lemo'))
                for rel in ('core/lib.js', 'LICENSE', 'MIT.txt'):
                    tar.add(os.path.join(vendor, rel), 'episode/lemo/vendor/' + rel)
        tar.add(ENGINE_DIR, 'engine', filter=lambda ti: None if '__pycache__' in ti.name else ti)
    return out


def stage_upload(ctx):
    T = load_timeline(ctx)
    number = ctx.db.assign_episode_number(ctx.job['episode_id'])
    today = dt.datetime.now(zoneinfo.ZoneInfo(config.TZ)).strftime('%Y-%m-%d')
    folder_name = f"EP{number:03d}_{slug_th(ctx.pkg['title_th'])}_{today}"
    prev = ctx.r.get('UPLOADING_DRIVE_partial') or {}
    if prev.get('folder_name'):
        folder_name = prev['folder_name']
    out = ctx.path('deliver')
    final = ctx.fetch(ctx.r['QUALITY_CHECK']['final_key'], ctx.path('final_qa.mp4'))
    base = f"EP{number:03d}_{slug_th(ctx.pkg['title_th'])}"
    os.makedirs(out, exist_ok=True)
    files = {}
    mp4 = os.path.join(out, f'{base}.mp4'); shutil.copyfile(final, mp4); files[os.path.basename(mp4)] = (mp4, 'video/mp4')
    th = make_thumbnail(ctx, T, number, os.path.join(out, f'{base}_thumbnail.png'), video=mp4); files[os.path.basename(th)] = (th, 'image/png')
    for name, pth in write_docs(ctx, T, number, out).items():
        mime = {'.txt': 'text/plain', '.md': 'text/markdown', '.srt': 'application/x-subrip', '.json': 'application/json'}[os.path.splitext(name)[1]]
        files[name] = (pth, mime)
    arc = make_archive(ctx, T, os.path.join(out, f'{base}_source.tar.gz')); files[os.path.basename(arc)] = (arc, 'application/gzip')
    for name, (pth, mime) in files.items():
        ctx.save('deliverable', pth, f'{ctx.prefix}/deliver/{name}', mime)
    ctx.db.save_stage(ctx.job, 'UPLOADING_DRIVE_partial', {'folder_name': folder_name})
    if r2_mod.enabled():
        cl = r2_mod._client()
        prefix = f"{config.R2_PREFIX}/{folder_name}"
        uploaded = [r2_mod.upload_verified(cl, pth, f'{prefix}/{name}', mime) | {'name': name} for name, (pth, mime) in files.items()]
        if not all(u['verified'] for u in uploaded) or len(uploaded) != len(files):
            raise RuntimeError('R2 verification incomplete: ' + json.dumps([u for u in uploaded if not u['verified']]))
        video = next(u for u in uploaded if u['name'].endswith('.mp4'))
        ctx.db.q('UPDATE episodes SET drive_folder_id=%s, drive_folder_url=%s WHERE id=%s', (prefix, video['url'], ctx.job['episode_id']))
        ctx.db.q("""INSERT INTO publication_handoffs (episode_id, job_id, folder_id, folder_url, files) VALUES (%s,%s,%s,%s,%s)""",
                 (ctx.job['episode_id'], ctx.job['id'], prefix, video['url'], json.dumps(uploaded)))
        return {'episode_number': number, 'folder_id': prefix, 'folder_url': video['url'], 'video_url': video['url'],
                'folder_name': folder_name, 'files': uploaded, 'storage': 'r2'}
    d = drive_mod.Drive()
    root = d.folder(config.DRIVE_ROOT)
    ready = d.folder(config.DRIVE_READY, root['id'])
    ep = d.folder(folder_name, ready['id'])
    uploaded = []
    for name, (pth, mime) in files.items():
        m = d.upload(pth, name, ep['id'], mime)
        uploaded.append({'name': name, 'drive_id': m['id'], 'bytes': int(m.get('size', 0)), 'md5': m.get('md5Checksum'), 'verified': m['verified'], 'link': m.get('webViewLink')})
    if not all(u['verified'] for u in uploaded) or len(uploaded) != len(files):
        raise RuntimeError('Drive verification incomplete')
    ctx.db.q('UPDATE episodes SET drive_folder_id=%s, drive_folder_url=%s WHERE id=%s', (ep['id'], ep.get('webViewLink'), ctx.job['episode_id']))
    ctx.db.q("""INSERT INTO publication_handoffs (episode_id, job_id, folder_id, folder_url, files) VALUES (%s,%s,%s,%s,%s)""",
             (ctx.job['episode_id'], ctx.job['id'], ep['id'], ep.get('webViewLink'), json.dumps(uploaded)))
    return {'episode_number': number, 'folder_id': ep['id'], 'folder_url': ep.get('webViewLink'), 'folder_name': folder_name, 'files': uploaded}


STAGES = {'GENERATING_AUDIO': stage_audio, 'BUILDING_TIMELINE': stage_timeline, 'RENDERING': stage_render,
          'QUALITY_CHECK': stage_qa, 'UPLOADING_DRIVE': stage_upload}
PROGRESS = {'GENERATING_AUDIO': 0.15, 'BUILDING_TIMELINE': 0.25, 'RENDERING': 0.75, 'QUALITY_CHECK': 0.85, 'UPLOADING_DRIVE': 0.98}


def run_episode(ctx, worker):
    job, db = ctx.job, ctx.db
    start = job['status'] if job['status'] in STAGES else 'GENERATING_AUDIO'
    for st in ORDER[ORDER.index(start):]:
        if st == 'READY_TO_POST':
            res = ctx.r['UPLOADING_DRIVE']
            db.q('UPDATE jobs SET result=%s, locked_by=NULL, locked_until=NULL, error=NULL WHERE id=%s', (json.dumps(res), job['id']))
            db.status(job, 'READY_TO_POST', 'READY_TO_POST', 1.0, f"EP{res['episode_number']:03d} delivered to " + ('Cloudflare R2' if res.get('storage') == 'r2' else 'Google Drive'), {'folder_url': res['folder_url']})
            return res
        db.status(job, st, st, None, f'{st} started')
        if st in ctx.r:
            db.event(job['id'], f'{st} already completed earlier; reusing stored results', None, status=st)
            continue
        aid = db.attempt_start(job, st, worker)
        try:
            res = STAGES[st](ctx)
        except Exception as e:
            db.attempt_end(aid, False, repr(e)[:2000])
            raise
        db.attempt_end(aid, True)
        db.save_stage(job, st, res)
        db.q('UPDATE jobs SET progress=%s WHERE id=%s', (PROGRESS[st], job['id']))
