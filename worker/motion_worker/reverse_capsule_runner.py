"""Actual upstream API adapter. This process never receives provider secrets.

It can normalize/materialize/validate recipes and preview dispatch plans, never
run a generation runner, arbitrary module, local_script, shell or provider tool.
"""
import json
import sys
import hashlib
from pathlib import Path


def main(request):
    root = Path(request['runtime']).resolve(); out = Path(request['output']).resolve()
    sys.path[:0] = [str(root / 'scripts'), str(root / 'lib')]
    from src.video_to_capsule import normalize_video_analysis, materialize_capsule_from_draft
    from capsule_package_validate import validate_capsule_dir
    from src.capsules.dispatch import build_dispatch_plan
    from src.capsules.loader import load_definition
    import yaml
    op, payload = request['operation'], request['payload']
    if op == 'recipe.create':
        name = payload['name']
        if not name.replace('_', '').replace('-', '').isalnum() or len(name) > 80: raise ValueError('Invalid recipe name')
        raw = payload['recipe']
        if raw.get('execution_strategy', {}).get('mode') != 'preset': raise ValueError('Only reviewed preset recipes are accepted')
        # Reusable rules contain placeholders, never source files, episode copy,
        # private URLs, character names, or provider credentials.
        _, draft = normalize_video_analysis(raw, source_video_path='episode-input-is-not-reusable.mp4',
            analysis_tool='MotionApprovedProductionPlan', capsule_name=name,
            capsule_display_name=payload.get('display_name', name), require_source_file=False)
        # The normalizer keeps episode observations in analysis/lessons. They
        # are deliberately excluded from the reusable package supplied here.
        draft['analysis']['source_summary'] = 'Versioned reusable production rules; episode inputs are supplied at run time.'
        draft['lessons'] = []
        path = materialize_capsule_from_draft(draft, source_video_path='episode-input-is-not-reusable.mp4',
            output_root=out, include_source_video=False, overwrite=False)
        report = validate_capsule_dir(path)
        if report.get('errors'): raise ValueError('Upstream capsule validation failed: ' + str(report['errors']))
        # Episode deny-literals are transient audit inputs, not reusable recipe
        # content. Upstream's contract otherwise retains those private names in
        # content_scope.yaml even though it excludes them from active surfaces.
        scope_path=Path(path)/'contracts/content_scope.yaml'
        scope=yaml.safe_load(scope_path.read_text())
        literals=scope.get('forbidden_reusable_literals',[])
        for surface in Path(path).rglob('*'):
            if not surface.is_file() or surface==scope_path or surface.suffix not in ('.md','.yaml','.yml','.json','.py'):continue
            body=surface.read_text().casefold()
            if any(literal.casefold() in body for literal in literals):raise ValueError('Episode-specific content leaked into a reusable recipe surface')
        scope['forbidden_reusable_literals']=[]
        scope_path.write_text(yaml.safe_dump(scope,allow_unicode=True,sort_keys=False))
        report=validate_capsule_dir(path)
        if report.get('errors'):raise ValueError('Sanitized reusable capsule failed upstream validation')
        definition = load_definition(path)
        definition_data=definition.model_dump(mode='json')
        resources={}
        for relative in sorted({r for group in definition_data['read_order'].values() for r in group}):
            resource=(Path(path)/relative).resolve()
            if not resource.is_relative_to(Path(path).resolve()) or not resource.is_file():continue
            if resource.stat().st_size>65536:raise ValueError('Reusable recipe resource is too large')
            content=resource.read_text()
            resources[relative]={'sha256':hashlib.sha256(content.encode()).hexdigest(),'content':content}
        return {'path': str(path), 'validation': report, 'definition': definition_data,'resources':resources,
                'upstream': 'capsule-cinema', 'scope_audit':{'checked_literal_count':len(literals),'episode_literals_retained':False},'paid_requests': 0}
    if op in ('recipe.validate', 'recipe.plan'):
        path = Path(payload['path']).resolve()
        if not path.is_relative_to(out): raise ValueError('Recipe path escapes the production workspace')
        report = validate_capsule_dir(path)
        if report.get('errors'): return {'ok': False, 'validation': report, 'paid_requests': 0}
        if op == 'recipe.validate': return {'ok': True, 'validation': report, 'paid_requests': 0}
        plan = build_dispatch_plan(path, payload.get('topic', '{{topic}}'), payload.get('params', {}), out / 'plan', 'plan')
        # build_dispatch_plan creates the upstream versioned lifecycle and
        # production plan. Do NOT execute_dispatch_plan (it may call providers).
        return {'ok': True, 'validation': report, 'dispatch': plan.model_dump(mode='json'),
                'production_plan': json.loads(Path(plan.lifecycle.plan_path).read_text()) if plan.lifecycle else None,
                'generation_dispatch': 'requires_motion_quote_and_approval', 'paid_requests': 0}
    raise ValueError('Operation is not in the safe Capsule API allowlist')


if __name__ == '__main__':
    print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
