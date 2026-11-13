"""Render verified per-shot Vision observations through upstream VIDEO.md API.

Use a NEW derived package. Never reclassify forensic evidence or mark a human.
"""
import json
import sys
from pathlib import Path


def main(request):
    root=Path(request['runtime']);sys.path.insert(0,str(root))
    from rea_video import videomd
    from rea_video.i18n import set_lang
    out=Path(request['package']);b=json.loads((out/'breakdown.json').read_text());set_lang('en');b['lang']='en'
    observed={x['id']:x['semantic'] for x in request['analysis']['shots'] if x.get('semantic')}
    for shot in b['shots']:
        a=observed.get(shot['id'])
        if not a:continue
        # Upstream supports descriptions and replication prompts in its VLM
        # observation surface. Classification probabilities remain unchanged.
        shot['vlm']={**(shot.get('vlm') or {}),'description':a['scene_description'],
            'evidence':['Motion per-shot Vision interpretation; not a human review or verified production provenance.']+a['uncertainty'],
            'replication':{'video_prompt':a['reverse_prompt'],'video_prompt_en':a['reverse_prompt']}}
    b['analysis']['vlm']['used']=bool(observed)
    b['analysis']['motion_vision']={'observed_shots':list(observed),'review':'model_estimated_not_human_reviewed',
        'normalized_schema':'motion.reverse.analysis.v1','timing_authority':'original measured frame indices; upstream display times may be rounded'}
    (out/'breakdown.json').write_text(json.dumps(b,ensure_ascii=False,indent=2))
    (out/'motion-normalized.json').write_text(json.dumps(request['analysis'],ensure_ascii=False,indent=2))
    entry=videomd.write(b,out);problems=videomd.check(out)
    if problems:raise ValueError('Derived upstream VIDEO.md is invalid: '+str(problems))
    return {'entry':str(entry),'validated':True,'observed_shots':list(observed),'human_reviewed':False}


if __name__=='__main__':print(json.dumps(main(json.load(sys.stdin))))
