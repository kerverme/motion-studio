"""Motion queue orchestration for actual rea-video and Capsule Cinema.

Measured evidence is immutable; paid semantic/production results are versioned.
No source asset is automatically reused as a remake asset.
"""
import copy
import datetime as dt
import hashlib
import json
import mimetypes
import os
import shutil
import tarfile
import threading
import time
import uuid
from pathlib import Path
from psycopg.types.json import Jsonb
import jsonschema
from . import config
from .reverse_runtime import runtime_status,decompose,capsule_call,render_videomd
from .reverse_media import fetch_private,save_private,normalized_analysis,clip,file_sha,key_id,frame_timing,replicate_private
from .reverse_provider import fal_call,response_text,parse_object,fingerprint
from .reverse_render import code_motion,normalize,compose,technical_qa,assemble,ffmpeg,subtitles
from .reverse_audio import produce_audio
from .text_video import ApprovalRequired,check_active,download_video
from .creative_ledger import digest,AmbiguousCall
from . import reverse_prompts


def schemas():return json.loads(Path(__file__).with_name('reverse-schemas.json').read_text())


def source_prompt(value,shot):
    lines=[f'One continuous shot, {shot["duration_s"]:.6f} seconds, no cuts.','Characters:']
    lines.extend(f'[{c["ref"]}]: {c["description"]}. Screen position: {c["position"]}.' for c in value['characters'])
    if not value['characters']:lines.append('No visible characters.')
    lines.extend(['Location: '+value['location']['description'],'Objects and props: '+('; '.join(o['label']+': '+o['description']+'; position: '+o['position'] for o in value['objects']) or 'None reliably identified.'),
        'Opening frame: '+value['starting_state'],'Action timeline (measured source seconds):'])
    lines.extend(f'{a["t0"]:.6f}–{a["t1"]:.6f}s: {a["text"]}' for a in value['character_actions'])
    lines.extend(['Ending frame: '+value['ending_state'],'Camera: '+'. '.join(value['camera'].values()),'Lighting: '+value['lighting'],'Visual style: '+value['visual_style'],
        'Preserve these screen positions, action timing and screen direction. Do not add unrequested characters, subtitles, logos or spoken dialogue.'])
    return '\n'.join(lines)


def validate_semantic(value,shot):
    jsonschema.validate(value,schemas()['semantic'])
    if value['shot_id']!=shot['id']:raise ValueError('Vision returned another shot')
    if not value['scene_description'].strip() or not value['reverse_prompt'].strip() or '[MOCK]' in value['reverse_prompt']:
        raise ValueError('A real scene description and reverse prompt are required')
    if value['audio']['heard'] or value['audio']['dialogue']:raise ValueError('The approved clip excluded audio; hearing claims rejected')
    stretch=shot['clip']['stretch'];result=copy.deepcopy(value)
    for event in result['character_actions']:
        if not 0<=event['t0']<=event['t1']<=shot['clip']['duration_s']+.05:raise ValueError('Vision action time is outside source clip')
        event['t0']/=stretch;event['t1']=min(shot['duration_s'],event['t1']/stretch)
    result['motion_timeline']=copy.deepcopy(result['character_actions'])
    result['reverse_prompt_model']=result['reverse_prompt']
    result['reverse_prompt']=source_prompt(result,shot)
    result['prompt_composition']='Validated Vision fields composed with measured source timing; raw model prompt retained separately.'
    result['timing_basis']='measured_source_relative_seconds'
    result['uncertainty'].append('Reverse prompt is an interpretation, not the original production prompt or verified lens/tool metadata.')
    return result


def validate_planner(value,project):
    jsonschema.validate(value,schemas()['plan'])
    if value['project_id']!=str(project['id']) or value['source_sha256']!=project['source_sha256']:raise ValueError('Planner changed source binding')
    if value['base_revision']!=project['current_revision']:raise ValueError('Planner was based on a stale revision')
    known={x['id']:x for x in project['analysis']['shots']};seen=set()
    if [s['shot_id'] for s in value['shots']]!=list(known):raise ValueError('Planner must preserve measured shot order')
    for shot in value['shots']:
        if shot['shot_id'] not in known or shot['shot_id'] in seen:raise ValueError('Planner changed or duplicated shot IDs')
        seen.add(shot['shot_id'])
        if shot['human_reviewed'] or shot['references']:raise ValueError('Planner cannot approve its own work or select unapproved pixels')
        if any(c['keep_source'] or c['rights_confirmed'] for c in shot['characters'].values()):raise ValueError('Planner cannot grant character rights')
        if shot['location'] and (shot['location']['keep_source'] or shot['location']['rights_confirmed']):raise ValueError('Planner cannot grant location rights')
        if shot['method']!='generative' and not shot.get('graphic'):raise ValueError('Code/hybrid requires explicit typed graphics')
    if set(known)!=seen:raise ValueError('Planner must retain every measured shot')
    value['origin']='planner'
    return value


def _asset(ctx,ident,project):
    row=ctx.db.one('SELECT * FROM reverse_assets WHERE id=%s AND project_id=%s',(ident,project['id']))
    if not row:raise ValueError('Asset is missing from this project')
    return row


def analyze(ctx,project,spec):
    source_asset=_asset(ctx,project['source_asset_id'],project)
    suffix=Path(project['source']['filename']).suffix.lower()
    if suffix not in ('.mp4','.mov','.webm','.mkv','.m4v'):suffix='.mp4'
    source=fetch_private(ctx,source_asset,ctx.path('source','reference'+suffix));replicate_private(ctx,source_asset,ctx.dir)
    out=Path(ctx.path('rea-package'))
    if project.get('analysis'):return {'cached':True,'analysis':project['analysis']}
    if out.exists() and not (out/'breakdown.json').is_file():
        # Only this job's incomplete local scratch directory; never a source or
        # another analysis version. Durable artifacts are never deleted here.
        shutil.rmtree(out)
    if not out.exists():
        ctx.db.status(ctx.job,'RUNNING','REA_VIDEO',.1,'rea-video: measured shot detection; no paid LLM')
        result=decompose(source,out,**spec['options']);raw=result['analysis']
    else:
        # Resume only if the actual upstream validator accepts the complete package.
        from .reverse_runtime import roots,environment
        import subprocess
        subprocess.run([str(roots()['rea_video']/'.venv/bin/rea-video'),'videomd',str(out),'--check'],env=environment(out),capture_output=True,check=True,timeout=60)
        raw=json.loads((out/'breakdown.json').read_text())
    analysis=normalized_analysis(raw,source);analysis['upstreams']=runtime_status();analysis['VIDEO_md_validated']=True
    analysis['video_md']=(out/'VIDEO.md').read_text()
    for i,shot in enumerate(analysis['shots']):
        check_active(ctx)
        path=ctx.path('vision-clips',shot['id']+'.mp4');meta=clip(source,shot,path)
        asset=save_private(ctx,project['id'],path,'shot_clip',shot_id=shot['id'],content_type='video/mp4',metadata=meta)
        shot['clip']={**meta,'asset_id':str(asset['id'])};shot['reference_frames']=[]
        for frame in [out/'shots'/(shot['id']+suffix) for suffix in ('.jpg','_first.jpg','_last.jpg')]:
            if not frame.is_file():continue
            asset=save_private(ctx,project['id'],frame,'source_frame',shot_id=shot['id'],content_type='image/jpeg',metadata={'path':str(frame.relative_to(out)),'reference_only':True})
            shot['reference_frames'].append(str(asset['id']))
        ctx.db.status(ctx.job,'RUNNING','REA_VIDEO',.15+.65*(i+1)/len(analysis['shots']),f'Measured evidence prepared {i+1}/{len(analysis["shots"])}')
    # Preserve the genuine original package, stems, full-res frames and report.
    # Keep an unmodified VIDEO.md plus a separate normalized schema.
    archive=ctx.path('evidence','rea-video-package.tar.gz')
    with tarfile.open(archive,'w:gz') as tar:tar.add(out,arcname='rea-video')
    package=save_private(ctx,project['id'],archive,'rea_package',content_type='application/gzip',metadata={'validated':True,'upstreams':runtime_status()})
    md=save_private(ctx,project['id'],out/'VIDEO.md','video_md',content_type='text/markdown')
    analysis['package_asset_id']=str(package['id']);analysis['video_md_asset_id']=str(md['id'])
    for stem in sorted((out/'stems').glob('*.wav')) if (out/'stems').is_dir() else []:
        save_private(ctx,project['id'],stem,'audio_stem',content_type='audio/wav',metadata={'reference_only':True,'name':stem.name})
    ctx.db.q("UPDATE reverse_projects SET analysis=%s,status='measured',updated_at=now() WHERE id=%s AND analysis IS NULL",(Jsonb(analysis),project['id']))
    return {'analysis':analysis,'source_frames_preserved':True,'paid_requests':0}


def _merge_registry(registry,semantic):
    registry=copy.deepcopy(registry)
    for c in semantic['characters']:
        match=c.get('registry_match');rows=registry.setdefault('characters',[])
        found=next((x for x in rows if match and x['id']==match['id']),None)
        if found and match.get('distinctive') and match.get('confidence',0)>=.8:
            c['registry_id']=found['id']
        else:
            ident='char_'+str(max([int(x['id'].split('_')[1]) for x in rows] or [0])+1).zfill(3)
            c['registry_id']=ident;rows.append({'id':ident,'label':c['label'],'description':c['description'],'basis':'model_estimated_unreviewed'})
    place=semantic['location'];rows=registry.setdefault('locations',[]);match=place.get('registry_match')
    found=next((x for x in rows if x['id']==match),None)
    if found:place['registry_id']=found['id']
    elif place['description']:
        ident='loc_'+str(max([int(x['id'].split('_')[1]) for x in rows] or [0])+1).zfill(3)
        place['registry_id']=ident;rows.append({'id':ident,'label':place['label'],'description':place['description'],'basis':'model_estimated_unreviewed'})
    return registry


def refresh_videomd(ctx,project):
    current=ctx.db.one('SELECT * FROM reverse_projects WHERE id=%s',(project['id'],));analysis=current['analysis']
    archive=_asset(ctx,analysis['package_asset_id'],project)
    local=fetch_private(ctx,archive,ctx.path('derived','original-package.tar.gz'))
    workspace=Path(ctx.path('derived',uuid.uuid4().hex));workspace.mkdir()
    with tarfile.open(local) as tar:tar.extractall(workspace,filter='data')
    package=workspace/'rea-video';report=render_videomd(package,analysis)
    md=save_private(ctx,project['id'],package/'VIDEO.md','vision_video_md',content_type='text/markdown',metadata=report)
    derived=ctx.path('derived','vision-package.tar.gz')
    with tarfile.open(derived,'w:gz') as tar:tar.add(package,arcname='rea-video')
    asset=save_private(ctx,project['id'],derived,'vision_videomd_package',content_type='application/gzip',metadata=report)
    # Patch only report pointers/content; don't replace observations being merged
    # by another accepted analysis job.
    patch={'video_md':(package/'VIDEO.md').read_text(),'vision_video_md_asset_id':str(md['id']),'vision_package_asset_id':str(asset['id'])}
    ctx.db.q('UPDATE reverse_projects SET analysis=analysis||%s,updated_at=now() WHERE id=%s',(Jsonb(patch),project['id']))
    return {'video_md_asset_id':str(md['id']),'package_asset_id':str(asset['id']),'validation':report}


def vision(ctx,project,task,quote):
    shot=next(x for x in project['analysis']['shots'] if x['id']==task['shot_id'])
    if shot['clip']['sha256']!=task['clip']['sha256']:raise ApprovalRequired('Source clip changed since approval')
    paid=fal_call(ctx,project,task,quote);semantic=validate_semantic(parse_object(response_text(paid['response'])),shot)
    semantic['provenance']={'provider':'fal','model':task['model'],'call_id':paid['provider_id'],'response_asset_id':paid['response_asset_id'],'quote_id':quote['id'],'review':'model_estimated_not_human_reviewed'}
    # Merge one shot under row lock; preserve concurrent observations/owner edits.
    with ctx.db.lock,ctx.db.conn.transaction():
        current=ctx.db.conn.execute('SELECT * FROM reverse_projects WHERE id=%s FOR UPDATE',(project['id'],)).fetchone()
        data=current['analysis'];registry=_merge_registry(current['registry'],semantic)
        target=next(x for x in data['shots'] if x['id']==shot['id']);target.update(semantic=semantic,semantic_status='needs_review',uncertainty=semantic['uncertainty'])
        data['semantic_status']='needs_review' if all(x.get('semantic') for x in data['shots']) else 'partial'
        ctx.db.conn.execute("UPDATE reverse_projects SET analysis=%s,registry=%s,status='understood',updated_at=now() WHERE id=%s",(Jsonb(data),Jsonb(registry),project['id']))
    return {'shot_id':shot['id'],'semantic':semantic,'response_asset_id':paid['response_asset_id']}


def planner(ctx,project,task,quote):
    paid=fal_call(ctx,project,task,quote);plan=validate_planner(parse_object(response_text(paid['response'])),project)
    if plan.get('recipe_id')!=task.get('recipe_id'):raise ValueError('Planner changed the selected Capsule recipe version')
    # The request's exact API-generated analysis digest is authoritative; don't
    # recompute JS-number JSON hashes in Python.
    if plan['analysis_sha256']!=quote['analysis_sha256']:raise ApprovalRequired('Planner changed analysis binding')
    revision=digest(plan)
    with ctx.db.lock,ctx.db.conn.transaction():
        current=ctx.db.conn.execute('SELECT * FROM reverse_projects WHERE id=%s FOR UPDATE',(project['id'],)).fetchone()
        if current['current_revision']!=plan['base_revision'] or current['analysis']!=project['analysis']:raise ApprovalRequired('Project edited during planning; paid response retained for review')
        ctx.db.conn.execute('INSERT INTO reverse_versions(project_id,revision,parent_revision,origin,plan) VALUES(%s,%s,%s,\'planner\',%s) ON CONFLICT DO NOTHING',(project['id'],revision,plan['base_revision'],Jsonb(plan)))
        ctx.db.conn.execute("UPDATE reverse_projects SET current_revision=%s,status='planned',updated_at=now() WHERE id=%s",(revision,project['id']))
    return {'revision':revision,'plan':plan,'human_reviewed':False}


def recipe(ctx,project,spec):
    payload=spec['recipe'];data=copy.deepcopy(payload['recipe'])
    # Server derives forbidden episode literals from the authoritative project,
    # not merely the author-supplied list. Raw source text stays out of recipes.
    forbidden=[project['source_sha256'],project['title']]
    for group in ('characters','locations'):
        for row in project['registry'].get(group,[]):forbidden.extend([row.get('label',''),row.get('description','')])
    scope=data.setdefault('content_scope',{});values=scope.get('forbidden_reusable_literals',[])+[x for x in forbidden if len(x.strip())>=4]
    scope['forbidden_reusable_literals']=list({x.casefold():x for x in values}.values())
    payload={**payload,'recipe':data}
    workspace=ctx.path('capsule',uuid.uuid4().hex);result=capsule_call('recipe.create',payload,workspace)
    plan=capsule_call('recipe.plan',{'path':result['path'],'topic':'{{topic}}','params':{}},workspace)
    archive=ctx.path('capsule-package.tar.gz')
    with tarfile.open(archive,'w:gz') as tar:tar.add(result['path'],arcname=Path(result['path']).name)
    asset=save_private(ctx,project['id'],archive,'capsule_recipe',content_type='application/gzip')
    definition=result['definition'];definition['metadata'].pop('source_path',None)
    resources=result['resources']
    definition_hash=digest({'definition':definition,'resource_hashes':{k:v['sha256'] for k,v in resources.items()}})
    with ctx.db.lock,ctx.db.conn.transaction():
        ctx.db.conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))',(payload['name'],))
        row=ctx.db.conn.execute('INSERT INTO reverse_recipes(name,version,definition_hash,manifest,storage_key,validated,source_project) SELECT %s,coalesce(max(version),0)+1,%s,%s,%s,true,%s FROM reverse_recipes WHERE name=%s ON CONFLICT(definition_hash) DO NOTHING RETURNING *',
            (payload['name'],definition_hash,Jsonb({'definition':definition,'resources':resources,'validation':result['validation'],'production_plan':plan['production_plan'],'asset_id':str(asset['id'])}),asset['storage_key'],project['id'],payload['name'])).fetchone()
        if not row:row=ctx.db.conn.execute('SELECT id FROM reverse_recipes WHERE definition_hash=%s',(definition_hash,)).fetchone()
    return {'recipe_id':str(row['id']) if row else None,'validation':result['validation'],'production_plan':plan['production_plan'],'paid_requests':0}


def generate(ctx,project,task,quote):
    shot=task['shot'];measured=task['measured'];duration=task.get('delivery',{}).get('duration_s',measured['duration_s'])
    source=project['analysis']['source'];width,height=(1080,1920) if source['height']>=source['width'] else (1920,1080)
    base=ctx.path('generated',shot['shot_id']+'-base.mp4')
    if task['provider']=='local':code_motion(shot['graphic'],base,duration,width,height)
    else:
        paid=fal_call(ctx,project,task,quote);url=paid['response'].get('video',{}).get('url')
        if not url:raise ValueError('Provider returned no video; paid result retained')
        raw=ctx.path('generated',shot['shot_id']+'-raw.mp4');download_video(url,raw)
        save_private(ctx,project['id'],raw,'generated_raw',shot_id=shot['shot_id'],content_type='video/mp4',metadata={'quote_id':quote['id'],'provider_id':paid['provider_id']})
        normalize(raw,base,duration,width,height)
    tracks=[];cues=[]
    for audio in shot['audio']:
        step=ctx.db.one("SELECT result FROM reverse_steps WHERE job_id=%s AND slot=%s AND status='complete'",(ctx.job['id'],'audio:'+shot['shot_id']+':'+audio['id']))
        if not step:raise ApprovalRequired('Approved audio asset is not ready')
        value=step['result'];asset=_asset(ctx,value['asset_id'],project)
        if value['duration_s']>audio['duration_s']+.05:raise ValueError('Paid audio exceeds its approved slot; asset retained, no speech truncation or automatic regeneration')
        path=fetch_private(ctx,asset,ctx.path('audio',str(asset['id'])+'.mp3'));tracks.append({**audio,'path':str(path)})
        if shot['subtitle_mode']=='generated_alignment' and audio['role'] in ('narration','dialogue'):
            if not value['alignment_asset_id']:raise ValueError('No real provider subtitle alignment')
            alignment_asset=_asset(ctx,value['alignment_asset_id'],project)
            alignment=json.loads(fetch_private(ctx,alignment_asset,ctx.path('audio',str(alignment_asset['id'])+'.json')).read_text())
            cues.extend(subtitles(alignment,audio,duration))
    overlay=None
    if shot['method']=='hybrid' or cues:
        overlay=ctx.path('generated',shot['shot_id']+'-overlay.mov');code_motion(shot.get('graphic') if shot['method']=='hybrid' else {'background':'#000000','layers':[]},overlay,duration,width,height,transparent=True,cues=cues)
    final=ctx.path('generated',shot['shot_id']+'.mp4');compose(base,final,duration,tracks,overlay=overlay)
    qa=technical_qa(final,round(duration*30)/30,width,height,audio_expected=bool(tracks))
    asset=save_private(ctx,project['id'],final,'generated_shot',shot_id=shot['shot_id'],content_type='video/mp4',metadata={'quote_id':quote['id'],'revision':quote['revision'],'shot_spec_hash':task.get('shot_spec_hash'),'qa':qa,'generated':True})
    timing=frame_timing(final);qa_path=ctx.path('qa-clips',shot['shot_id']+'.mp4')
    qa_meta=clip(final,{'duration_s':timing['end_s'],'start_frame':0,'end_frame_exclusive':len(timing['pts']),'frame_count':len(timing['pts'])},qa_path)
    qa_asset=save_private(ctx,project['id'],qa_path,'generated_qa_clip',shot_id=shot['shot_id'],content_type='video/mp4',metadata={'parent_asset_id':str(asset['id'])})
    ctx.db.q("UPDATE reverse_assets SET metadata=metadata||%s WHERE id=%s",(Jsonb({'qa_clip':{**qa_meta,'asset_id':str(qa_asset['id'])}}),asset['id']))
    end=ctx.path('generated',shot['shot_id']+'-end.png');ffmpeg(['-sseof','-0.04','-i',final,'-frames:v','1',end])
    handoff=save_private(ctx,project['id'],end,'generated_last_frame',shot_id=shot['shot_id'],content_type='image/png',metadata={'parent_asset_id':str(asset['id']),'revision':quote['revision']})
    if not qa['ok']:raise ValueError('Technical QA failed; generated asset retained, no automatic regeneration')
    return {'shot_id':shot['shot_id'],'asset_id':str(asset['id']),'handoff_asset_id':str(handoff['id']),'qa':qa,'revision':quote['revision']}


def image_reference(ctx,project,task,quote):
    from PIL import Image
    paid=fal_call(ctx,project,task,quote);images=paid['response'].get('images',[])
    if len(images)!=1 or not images[0].get('url'):raise ValueError('Provider did not return one reference image')
    path=ctx.path('references',task['shot_id']+'.png');download_video(images[0]['url'],path)
    with Image.open(path) as img:
        if img.width*img.height>4000000:raise ValueError('Reference dimensions exceed approved profile')
        img.verify()
    asset=save_private(ctx,project['id'],path,'generated_reference',shot_id=task['shot_id'],content_type='image/png',metadata={'quote_id':quote['id'],'generated':True,'prompt':task['payload']['prompt']})
    return {'asset_id':str(asset['id']),'shot_id':task['shot_id'],'provider_id':paid['provider_id']}


def visual_qa(ctx,project,task,quote):
    paid=fal_call(ctx,project,task,quote);value=parse_object(response_text(paid['response']))
    schema={'type':'object','additionalProperties':False,'required':['shot_id','verdict','checks','uncertainty','repair_instructions'],
        'properties':{'shot_id':{'const':task['shot_id']},'verdict':{'enum':['pass','fail','uncertain']},'checks':{'type':'array','minItems':1,'maxItems':50,
            'items':{'type':'object','required':['criterion','matched','evidence','confidence'],'additionalProperties':False,'properties':{
                'criterion':{'type':'string','maxLength':1000},'matched':{'type':['boolean','null']},'evidence':{'type':'string','maxLength':3000},'confidence':{'type':'number','minimum':0,'maximum':1}}}},
            'uncertainty':{'type':'array','items':{'type':'string','maxLength':3000},'maxItems':50},'repair_instructions':{'type':'array','items':{'type':'string','maxLength':3000},'maxItems':50}}}
    jsonschema.validate(value,schema)
    if value['verdict']=='pass' and any(c['matched'] is not True for c in value['checks']):raise ValueError('QA verdict contradicts its checks')
    report=ctx.path('qa',task['shot_id']+'.json');Path(report).write_text(json.dumps(value,ensure_ascii=False))
    asset=save_private(ctx,project['id'],report,'visual_qa',shot_id=task['shot_id'],content_type='application/json',metadata={'generated_asset_id':task['generated_asset_id'],'model':task['model'],'quote_id':quote['id']})
    ctx.db.q('UPDATE reverse_assets SET metadata=metadata||%s WHERE id=%s AND project_id=%s',(Jsonb({'visual_qa':{**value,'report_asset_id':str(asset['id']),'model':task['model']}}),task['generated_asset_id'],project['id']))
    return {'shot_id':task['shot_id'],'qa':value,'report_asset_id':str(asset['id']),'automatic_repairs':0}


def final_assembly(ctx,project,spec):
    revision=spec['revision'];row=ctx.db.one('SELECT plan FROM reverse_versions WHERE project_id=%s AND revision=%s',(project['id'],revision))
    if not row:raise ValueError('Approved plan not found')
    plan=row['plan'];wanted=[x['shot_id'] for x in plan['shots']];measured={x['id']:x for x in project['analysis']['shots']}
    if set(wanted)!=set(measured):raise ValueError('Final assembly requires every measured shot; a partial plan remains a shot test')
    if set(spec['assets'])!=set(wanted):raise ValueError('Every planned shot needs exactly one new authorized asset')
    paths=[]
    for i,shot_id in enumerate(wanted):
        asset=_asset(ctx,spec['assets'][shot_id],project)
        if asset['role']!='generated_shot' or asset['shot_id']!=shot_id or not asset['metadata'].get('qa',{}).get('ok'):raise ValueError('Source or failed assets cannot be assembled as new production')
        if asset['metadata'].get('revision')!=revision:
            prior=ctx.db.one('SELECT plan FROM reverse_versions WHERE project_id=%s AND revision=%s',(project['id'],asset['metadata'].get('revision')))
            before=next((s for s in (prior or {}).get('plan',{}).get('shots',[]) if s['shot_id']==shot_id),None)
            after=next(s for s in plan['shots'] if s['shot_id']==shot_id)
            if before!=after:raise ValueError('Shot specification changed; approve a repair for this shot only')
        paths.append(str(fetch_private(ctx,asset,ctx.path('assembly',str(i).zfill(4)+'.mp4'))))
    output=ctx.path('assembly','final.mp4');assemble(paths,output,ctx.dir)
    duration=sum(round(measured[x]['end_s']*30)-round(measured[x]['start_s']*30) for x in wanted)/30
    info=project['analysis']['source'];width,height=(1080,1920) if info['height']>=info['width'] else (1920,1080)
    qa=technical_qa(output,duration,width,height,audio_expected=any(s['audio'] for s in plan['shots']))
    if not qa['ok']:raise ValueError('Assembly technical QA failed')
    final=save_private(ctx,project['id'],output,'final_video',content_type='video/mp4',metadata={'revision':revision,'qa':qa,'shot_assets':spec['assets']})
    return {'final_asset_id':str(final['id']),'qa':qa,'ordered_shots':wanted,'publishing':'not_requested'}


def run(ctx):
    spec=ctx.pkg['reverse'];project=ctx.db.one('SELECT * FROM reverse_projects WHERE id=%s',(spec['project_id'],))
    if not project or project['source_sha256']!=spec['source_sha256']:raise ApprovalRequired('Source binding changed')
    check_active(ctx)
    if spec['action'] in ('analyze','recipe','assemble','prompt_prepare'):
        result={'analyze':analyze,'recipe':recipe,'assemble':final_assembly,'prompt_prepare':reverse_prompts.prepare}[spec['action']](ctx,project,spec)
    else:
        quote=spec['quote'];approval=ctx.db.one('SELECT * FROM reverse_approvals WHERE quote_id=%s AND job_id=%s',(quote['id'],ctx.job['id']))
        if not approval or approval['binding']!=quote['binding']:raise ApprovalRequired('No persisted owner approval')
        result={'steps':[]}
        tasks=sorted(quote['tasks'],key=lambda t:0 if t['role']=='audio' else 1)
        for i,task in enumerate(tasks):
            check_active(ctx);slot=task['slot'];old=ctx.db.one('SELECT * FROM reverse_steps WHERE job_id=%s AND slot=%s',(ctx.job['id'],slot))
            if old and old['status']=='complete':result['steps'].append(old['result']);continue
            ctx.db.q('INSERT INTO reverse_steps(job_id,slot,project_id,shot_id,role,input_hash) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                (ctx.job['id'],slot,project['id'],task.get('shot_id'),task['role'],digest(task)))
            ctx.db.status(ctx.job,'RUNNING',task['role'].upper(),i/len(quote['tasks']),'Reverse production: '+slot)
            if task.get('handoff_previous_frame'):
                # Require a concrete approved predecessor asset. No silent image
                # fallback and no source-frame substitution.
                raise ApprovalRequired('Select the generated predecessor last frame as an explicit first-frame reference and quote again')
            fn={'vision':vision,'planner':planner,'video':generate,'audio':produce_audio,'image':image_reference,'visual_qa':visual_qa,'prompt_extract':reverse_prompts.extract}[task['role']]
            value=fn(ctx,project,task,quote)
            ctx.db.q("UPDATE reverse_steps SET status='complete',result=%s,updated_at=now() WHERE job_id=%s AND slot=%s",(Jsonb(value),ctx.job['id'],slot))
            result['steps'].append(value)
        if spec['action']=='vision':result['videomd']=refresh_videomd(ctx,project)
    ctx.db.q('UPDATE jobs SET result=%s,locked_by=NULL,locked_until=NULL,error=NULL WHERE id=%s',(Jsonb(result),ctx.job['id']))
    ctx.db.status(ctx.job,'READY_TO_POST',spec['action'].upper(),1,'Reverse task complete; output still requires owner review')
    return result


def capability_loop(stop):
    from .db import DB
    while not stop():
        try:
            db=DB();data={'runtime':runtime_status(),'openai':bool(os.environ.get('OPENAI_API_KEY')),'prompt_model':os.environ.get('MOTION_REVERSE_BRAIN_MODEL','gpt-6.1-sol'),'prompt_rate':json.loads(os.environ.get('MOTION_REVERSE_OPENAI_RATE_JSON','null')),'fal':bool(os.environ.get('FAL_KEY')),'eleven':bool(config.ELEVENLABS_API_KEY),
                'voice_id':config.DEFAULT_VOICE_ID,'tts_model':os.environ.get('MOTION_DEFAULT_TTS_MODEL','eleven_v4'),
                'sfx_model':os.environ.get('MOTION_DEFAULT_SFX_MODEL','eleven_text_to_sound_v3'),
                'key_fingerprints':{'openai':fingerprint('OPENAI_API_KEY'),'fal':fingerprint('FAL_KEY'),'eleven':fingerprint('ELEVENLABS_API_KEY')},'private_storage':bool(os.environ.get('MOTION_REVERSE_STORAGE_KEY'))}
            db.q("INSERT INTO integrations(provider,data,updated_at) VALUES('reverse_worker',%s,now()) ON CONFLICT(provider) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",(Jsonb(data),));db.conn.close()
        except Exception as error:print('Reverse capability heartbeat:',type(error).__name__,flush=True)
        for _ in range(30):
            if stop():return
            time.sleep(1)
