"""Local preview of a generated spec without ElevenLabs: synthetic word timings, contact sheet of frames per scene.

python -m motion_worker.preview [spec.json] out.png   (no spec -> the built-in sample)"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PIL import Image
from motion_worker.timeline import build_timeline


def fake_timeline(script, per=0.075, gap=0.35):
    text, st, en, t = '', [], [], 0.2
    for i, s in enumerate(script):
        if i:
            text += ' '; st.append(t); en.append(t + 0.01); t += gap
        for ch in s['text']:
            text += ch; st.append(t); en.append(t + per); t += per
    return build_timeline(script, text, st, en)


def scene_code(spec):
    return ('import json\nfrom engine.templates import build_scenes\n'
            f'SPEC = json.loads({json.dumps(json.dumps(spec, ensure_ascii=False), ensure_ascii=False)})\n'
            'SCENES = build_scenes(SPEC)\n')


def main():
    from engine import render, core, templates
    args = sys.argv[1:]
    if args and args[0].endswith('.json'):
        pkg = json.load(open(args.pop(0)))
        script, spec = pkg['script'], pkg['spec']
    else:
        from motion_worker import sample_spec
        script, spec = sample_spec.SCRIPT, sample_spec.spec()
    out = args[0] if args else 'preview.png'
    tl = fake_timeline(script)
    path = os.path.join(os.path.dirname(os.path.abspath(out)), '_preview_scenes.py')
    open(path, 'w').write(scene_code(spec))
    mod = render.load_episode_module(path, tl, None, 'จะเกิดอะไรขึ้นถ้า...?')
    fr = [0.12, 0.45, 0.75, 0.98]
    th = 480
    tw = int(th * 1080 / 1920)
    sheet = Image.new('RGB', (tw * len(fr), th * len(tl)), (0, 0, 0))
    for r, seg in enumerate(tl):
        for c, f in enumerate(fr):
            t = seg['s'] + (seg['e'] + 0.3 - seg['s']) * f
            im = render.frame(mod, t).resize((tw, th))
            sheet.paste(im, (c * tw, r * th))
    sheet.save(out)
    print(json.dumps({'scenes': len(tl), 'missing_words': core.MISSING_WORDS, 'errors': templates.ERRORS}, ensure_ascii=False))


if __name__ == '__main__':
    main()
