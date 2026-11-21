"""Quoted narrative reasoning and generated-only, temporal visual inspection.

All observations remain model estimates. Frame citations are measured, not a
claim that sampled stills prove exact physics or an unseen person's knowledge.
"""
import bisect
import copy
import json
import math
from pathlib import Path

import jsonschema
from psycopg.types.json import Jsonb
from . import reverse_prompts as prompts
from .reverse_media import fetch_private, save_private, frame_timing, file_sha
from .reverse_render import ffmpeg
from .reverse_progress import report
from .text_video import ApprovalRequired, check_active


def schemas():
    return json.loads(Path(__file__).with_name('scene_logic_schema.json').read_text())


def output_schema(role):
    return schemas()[{'scene_logic':'director','video_inspection':'inspection'}[role]]


def citations(rows,evidence):
    known={f['frame']:f for f in evidence['frames']}
    unique={}
    for citation in rows:
        f=known.get(citation['frame_index'])
        if not f or not math.isfinite(citation['at_s']) or abs(f['at_s']-citation['at_s'])>1e-6:
            raise ValueError('Citation is not a measured frame in this approved evidence')
        if not citation['observation'].strip():raise ValueError('Empty visual evidence')
        unique[(f['frame'],f['at_s'])]=f
    return list(unique.values())


def temporal_support(rows,evidence,start,end,cover=False):
    frames=citations(rows,evidence)
    # Distant frames elsewhere in a shot are not evidence for this action.
    relevant=[f for f in frames if start-.15<=f['at_s']<=end+.15]
    if len({f['asset_id'] for f in relevant})<2 or len({f['at_s'] for f in relevant})<2:return False
    if cover and (min(f['at_s'] for f in relevant)>start+.10 or max(f['at_s'] for f in relevant)<end-.10):return False
    return True


def validate_graph(raw,document,evidence):
    jsonschema.validate(raw,output_schema('scene_logic'))
    if len(json.dumps(raw,ensure_ascii=False))>250000:raise ValueError('Scene graph too large')
    if not 1<=len(raw['events'])<=300 or len(raw['issues'])>200:raise ValueError('Invalid scene graph size')
    value=copy.deepcopy(raw);shots={s['id']:s for s in document['shots']};actors={c['id'] for c in document['characters']}
    events={e['id']:e for e in value['events']};objects={o['id'] for o in value['objects']}
    if len(events)!=len(value['events']) or len(objects)!=len(value['objects']):raise ValueError('Duplicate scene entity/event IDs')
    coverage={s:set() for s in shots}
    for event in events.values():
        shot=shots.get(event['shot_id'])
        if not event['id'].strip() or not shot or not event['action'].strip():raise ValueError('Unknown or empty scene event')
        if not shot['start_s']<=event['start_s']<=event['end_s']<=shot['end_s']:raise ValueError('Scene event retimed outside its source shot')
        if any(c not in actors for c in event['actor_ids']) or any(o not in objects for o in event['object_ids']):raise ValueError('Unknown event actor or object')
        if not event['source_action_indices'] or any(i<0 or i>=len(shot['actions']) for i in event['source_action_indices']):raise ValueError('Scene event lacks a source action reference')
        actions=[shot['actions'][i] for i in event['source_action_indices']]
        if event['start_s']<min(a['t0'] for a in actions)-1e-6 or event['end_s']>max(a['t1'] for a in actions)+1e-6:raise ValueError('Scene event retimed outside its locked source actions')
        coverage[shot['id']].update(event['source_action_indices'])
        citations(event['evidence'],evidence)
        if event['basis']=='observed' and not temporal_support(event['evidence'],evidence,event['start_s'],event['end_s']):
            event['basis']='inferred';event['uncertainty']+=' Temporal evidence is insufficient; a single frame cannot establish this event.'
    if any(coverage[s]!=set(range(len(shots[s]['actions']))) for s in shots):raise ValueError('Scene graph omitted source actions')
    edges={e:[] for e in events}
    for dep in value['dependencies']:
        if dep['from'] not in events or dep['to'] not in events or dep['from']==dep['to']:raise ValueError('Invalid causal dependency reference')
        before,after=events[dep['from']],events[dep['to']]
        if before['start_s']>after['start_s']+1e-6:raise ValueError('Causal dependency reverses source time')
        edges[dep['from']].append(dep['to'])
        if dep['basis']=='observed' and (before['basis']!='observed' or after['basis']!='observed'):dep['basis']='inferred'
    visiting=set();done=set()
    def visit(node):
        if node in visiting:raise ValueError('Causal dependency graph has a cycle')
        if node in done:return
        visiting.add(node)
        for nxt in edges[node]:visit(nxt)
        visiting.remove(node);done.add(node)
    for node in events:visit(node)
    for obj in value['objects']:
        for state in obj['states']:
            if state['event_id'] not in events or state['owner_id'] is not None and state['owner_id'] not in actors:raise ValueError('Unknown object continuity reference')
            if state['basis']=='observed' and events[state['event_id']]['basis']!='observed':state['basis']='inferred'
    locations={loc['id'] for loc in document.get('locations',[])}
    for spatial in value['spatial']:
        if spatial['event_id'] not in events or spatial['character_id'] not in actors:
            raise ValueError('ผลตรวจตำแหน่งอ้างถึงเหตุการณ์หรือตัวละครที่ไม่มีในฉาก')
        misplaced=[ref for ref in spatial['visible_objects'] if ref not in objects]
        if any(ref not in locations and ref not in actors for ref in misplaced):
            raise ValueError('ผลตรวจการมองเห็นอ้างถึงวัตถุที่ไม่มีในหลักฐานของฉาก')
        if misplaced:
            spatial['visible_objects']=[ref for ref in spatial['visible_objects'] if ref in objects]
            spatial['basis']='unknown'
            spatial['uncertainty']+=' Visibility unverified for non-object references: '+', '.join(dict.fromkeys(misplaced))+'.'
        if spatial['basis']=='observed' and events[spatial['event_id']]['basis']!='observed':spatial['basis']='inferred'
        caveat='Position, field of view and knowledge are approximate, not exact visibility calculations.'
        if caveat not in spatial['uncertainty']:spatial['uncertainty']+=' '+caveat
    issue_ids=set()
    for issue in value['issues']:
        if not math.isfinite(issue['confidence']):raise ValueError('Invalid issue confidence')
        if issue['id'] in issue_ids or issue['shot_id'] not in shots or any(e not in events for e in issue['event_ids']):raise ValueError('Invalid issue references')
        issue_ids.add(issue['id']);citations(issue['evidence'],evidence)
        if issue['basis']=='observed' and (not issue['event_ids'] or any(events[e]['basis']!='observed' or not temporal_support(issue['evidence'],evidence,events[e]['start_s'],events[e]['end_s']) for e in issue['event_ids'])):
            issue['basis']='inferred';issue['uncertainty']+=' Not confirmed by sufficient temporal evidence.'
    return value


def _parsed(paid):
    value=paid['response']
    if value.get('status')!='completed':
        reason=(value.get('incomplete_details') or {}).get('reason')
        if reason=='max_output_tokens':
            raise ValueError('คำตอบตรวจฉากเกินขีดจำกัดข้อความ (max_output_tokens) และ JSON ถูกตัด จึงยังใช้ผลนี้ไม่ได้ กดดูราคาตรวจตรรกะฉากใหม่แล้วตรวจราคาและยืนยันอีกครั้ง ระบบเก็บคำตอบเดิมไว้และไม่ส่งคำขอเสียเงินซ้ำอัตโนมัติ')
        # Never display arbitrary provider text (which can echo private source data).
        raise ValueError('การตรวจฉากไม่สำเร็จ: OpenAI ส่งคำตอบไม่ครบหรือหยุดประมวลผล ระบบเก็บคำตอบเดิมไว้ กรุณาขอราคาใหม่ก่อนยืนยันการตรวจอีกครั้ง ไม่มีการส่งซ้ำอัตโนมัติ')
    contents=[c for o in value.get('output',[]) for c in o.get('content',[])]
    if any(c.get('type')=='refusal' for c in contents):
        raise ValueError('OpenAI ปฏิเสธการตรวจฉากนี้ กรุณาตรวจเนื้อหาหรือเลือกช่วงคลิปอื่น ไม่มีการส่งซ้ำอัตโนมัติ')
    text=''.join(c.get('text','') for c in contents if c.get('type')=='output_text')
    try:return json.loads(text)
    except (ValueError,TypeError):
        raise ValueError('คำตอบตรวจฉากเป็น JSON ไม่สมบูรณ์ ระบบเก็บคำตอบเดิมไว้และไม่ส่งคำขอเสียเงินซ้ำอัตโนมัติ') from None


def _version(ctx,project,context):
    row=ctx.db.one('SELECT * FROM reverse_prompt_versions WHERE id=%s AND project_id=%s',(context['version_id'],project['id']))
    if context['input_hash']!=prompts.canonical_hash({'document':context['document'],'replacements':context['replacements'],'main_character_id':context.get('main_character_id')}):raise ApprovalRequired('Scene input binding mismatch')
    if not row or row['document']!=context['document'] or row['locks_hash']!=context['locks_hash'] or prompts.motion_lock(row['document'])!=row['locks_hash']:
        raise ApprovalRequired('Source prompt version or locked directions changed')
    main=context.get('main_character_id')
    if main and main not in {c['id'] for c in row['document']['characters']}:raise ApprovalRequired('Unknown main character')
    saved=row['replacements'];effective={'characters':{main:saved['characters'][main]} if main and saved['characters'].get(main) else {},'locations':saved.get('locations') or {}}
    if context['replacements']!=effective:raise ApprovalRequired('Saved character or location replacements changed')
    return row


def _graph_gate(graph):
    review=graph.get('review') or {};dismissed=set(review.get('dismissed_issue_ids') or []);confirmed=set(review.get('confirmed_issue_ids') or [])
    if review.get('requires_revalidation'):raise ApprovalRequired('Creative source changes require a new Scene Logic Check')
    if any(i['severity']=='critical' and i['id'] not in dismissed and (i['id'] in confirmed or i['basis']=='observed') for i in graph['graph']['issues']):
        raise ApprovalRequired('Critical scene contradiction requires owner review before generation')


def canonical_source_action(document,event):
    shot=next(s for s in document['shots'] if s['id']==event['shot_id'])
    return ' '.join(shot['actions'][i]['text'] for i in sorted(set(event['source_action_indices'])))


def generation_preflight(ctx,project,quote):
    """Run before ANY task (including ElevenLabs), and again before Fal dispatch."""
    if quote.get('purpose') not in ('generate','repair','prompt_video'):return
    binding=quote.get('scene_logic')
    if not binding:
        if quote.get('purpose')=='prompt_video':raise ApprovalRequired('Missing range scene review')
        if ctx.db.one('SELECT id FROM reverse_prompt_versions WHERE project_id=%s LIMIT 1',(project['id'],)):
            raise ApprovalRequired('Generation requires the checked scene graph and a fresh bound quote')
        return # Existing projects without the focused A/B workflow remain unchanged.
    graph=ctx.db.one('SELECT * FROM reverse_scene_graphs WHERE id=%s AND project_id=%s',(binding['graph_id'],project['id']))
    if not graph:raise ApprovalRequired('Scene graph no longer exists')
    latest=ctx.db.one('SELECT id FROM reverse_scene_graphs WHERE project_id=%s AND version_id=%s AND input_hash=%s ORDER BY created_at DESC,id DESC LIMIT 1',(project['id'],graph['version_id'],graph['input_hash']))
    version=ctx.db.one('SELECT * FROM reverse_prompt_versions WHERE id=%s AND project_id=%s',(graph['version_id'],project['id']))
    if not latest or latest['id']!=graph['id'] or not version:raise ApprovalRequired('Newer scene review invalidated the generation quote')
    main=graph['provenance'].get('main_character_id');replacements=version['replacements']
    effective={'characters':{main:replacements['characters'][main]} if main and replacements['characters'].get(main) else {},'locations':replacements.get('locations') or {}}
    expected=prompts.canonical_hash({'document':version['document'],'replacements':effective,'main_character_id':main})
    if graph['source_sha256']!=project['source_sha256'] or expected!=graph['input_hash'] or prompts.motion_lock(version['document'])!=graph['locks_hash'] or any(binding.get(k)!=v for k,v in [('version_id',version['id']),('input_hash',expected),('locks_hash',graph['locks_hash']),('graph_hash',prompts.canonical_hash(graph['graph'])),('review_hash',prompts.canonical_hash(graph['review']))]):
        raise ApprovalRequired('Scene generation binding changed; obtain a new quote')
    _graph_gate(graph)
    if quote['purpose']=='prompt_video':
        source=ctx.db.one("""SELECT id,locks_hash FROM reverse_prompt_versions WHERE project_id=%s AND selection_id=%s
            AND replacements->'characters'='{}'::jsonb AND replacements->'locations'='{}'::jsonb
            ORDER BY (document ? 'audio') DESC,created_at DESC,id DESC LIMIT 1""",(project['id'],version['selection_id']))
        active=source
        if source and binding.get('variant')=='b':
            active=ctx.db.one("""SELECT id FROM reverse_prompt_versions WHERE project_id=%s AND selection_id=%s AND locks_hash=%s
                AND (replacements->'characters'<>'{}'::jsonb OR replacements->'locations'<>'{}'::jsonb)
                ORDER BY created_at DESC,id DESC LIMIT 1""",(project['id'],version['selection_id'],source['locks_hash']))
        if not active or active['id']!=version['id']:
            raise ApprovalRequired('A newer saved prompt invalidated this range quote')
        tasks=quote.get('tasks') or []
        if len(tasks)!=1 or tasks[0].get('role')!='prompt_video' or tasks[0].get('endpoint')!='minimax/h3-max/text-to-video' or prompts.canonical_hash(tasks[0]['payload'])!=binding.get('payload_hash'):
            raise ApprovalRequired('Range prompt differs from approved review')
    for task in quote.get('tasks',[]):
        if task['role']=='video':
            shot_id=task.get('shot_id') or task.get('shot',{}).get('shot_id');wanted=binding.get('prompt_hashes',{}).get(shot_id)
            if not wanted or prompts.canonical_hash(task.get('payload',{}).get('prompt'))!=wanted or prompts.canonical_hash(task.get('shot',{}).get('prompt'))!=wanted:
                raise ApprovalRequired('Generation prompt differs from reviewed scene constraints')


def direct(ctx,project,task,quote,*,saved_only=False):
    context=task['payload']['context'];version=_version(ctx,project,context)
    selection=ctx.db.one('SELECT * FROM reverse_prompt_selections WHERE id=%s AND project_id=%s',(version['selection_id'],project['id']))
    if not selection or selection['evidence']!=task['payload']['evidence']:raise ApprovalRequired('Source visual evidence changed')
    ident=prompts.canonical_hash({'scene_quote':quote['id'],'version':version['id']})
    if ctx.db.one('SELECT id FROM reverse_scene_graphs WHERE id=%s',(ident,)):return {'graph_id':ident,'cached':True}
    paid=prompts.saved_scene_response(ctx,project,task,quote) if saved_only else None
    latest_sql='SELECT id,provenance FROM reverse_scene_graphs WHERE project_id=%s AND version_id=%s AND input_hash=%s ORDER BY created_at DESC,id DESC LIMIT 1'
    latest_args=(project['id'],version['id'],context['input_hash'])
    latest=ctx.db.one(latest_sql,latest_args)
    def already_recovered(row):
        return saved_only and row and row.get('provenance',{}).get('response_asset_id')==paid['response_asset_id']
    if already_recovered(latest):return {'graph_id':latest['id'],'cached':True}
    if (latest or {}).get('id')!=context.get('base_graph_id'):raise ApprovalRequired('Scene review changed before director dispatch')
    if saved_only:
        report(ctx,'scene_recovery','กำลังกู้ผลตรวจฉากจากคำตอบเดิม')
    else:
        report(ctx,'scene_director','Sol กำลังตรวจเหตุและผลของฉาก')
        paid=prompts.response_call(ctx,project,task,quote)
    graph=validate_graph(_parsed(paid),version['document'],selection['evidence'])
    parent_id=context.get('parent_graph_id');overrides=context.get('authorized_overrides') or []
    if parent_id:
        parent=ctx.db.one('SELECT * FROM reverse_scene_graphs WHERE id=%s AND project_id=%s',(parent_id,project['id']))
        if not parent or parent['version_id']!=version['id'] or parent['input_hash']!=context['input_hash']:raise ApprovalRequired('Parent graph binding changed')
        if context.get('parent_graph') is not None and context['parent_graph']!=parent['graph']:raise ApprovalRequired('Parent graph content changed')
        old_events={e['id']:e for e in parent['graph']['events']};new_events={e['id']:e for e in graph['events']}
        if new_events.keys()!=old_events.keys():raise ValueError('Revalidation changed source event IDs')
        edits={o['event_id']:o['text'] for o in overrides}
        if any(e not in old_events for e in edits):raise ValueError('Unknown authorized event')
        for event_id,event in new_events.items():
            old=old_events[event_id]
            if any(event[k]!=old[k] for k in ('shot_id','start_s','end_s','source_action_indices','actor_ids')):raise ValueError('Revalidation changed source timing or attribution')
            if event['action']!=edits.get(event_id,old['action']):raise ValueError('Revalidation changed an action without explicit owner approval')
            if event_id in edits:
                event['basis']='inferred';event['uncertainty']+=' Owner-approved creative intent; not an observed source fact.'
            elif event['mode']!=old['mode']:raise ValueError('Revalidation changed unmodified event causality')
    elif overrides:raise ApprovalRequired('Creative overrides require a reviewed parent graph')
    else:
        # The director's causal interpretation may be useful, but its wording
        # must never silently replace the immutable source action. The inspector
        # therefore judges the same canonical action the export compiler uses.
        for event in graph['events']:event['action']=canonical_source_action(version['document'],event)
    # Re-normalize dependent source claims after creative events are downgraded;
    # changing intent cannot turn a model inference into an observed source fact.
    if overrides:graph=validate_graph(graph,version['document'],selection['evidence'])
    review=copy.deepcopy(context.get('review') or {});review['requires_revalidation']=False
    review['confirmed_issue_ids']=[];review['dismissed_issue_ids']=[] # a new model issue must be reviewed on its own evidence
    provenance={'model':task['model'],'quote_id':quote['id'],'response_asset_id':paid['response_asset_id'],'provider_id':paid['provider_id'],'basis':'model_estimated_sampled_frames','source_events_changed':False,'main_character_id':context.get('main_character_id'),'selection_id':version['selection_id']}
    # The owner-review API uses this same project row lock. A late paid result
    # must not supersede a review saved while the model was still reasoning.
    with ctx.db.lock,ctx.db.conn.transaction():
        conn=ctx.db.conn;conn.execute('SELECT id FROM reverse_projects WHERE id=%s FOR UPDATE',(project['id'],))
        latest=conn.execute(latest_sql,latest_args).fetchone()
        if already_recovered(latest):return {'graph_id':latest['id'],'cached':True}
        if (latest or {}).get('id')!=context.get('base_graph_id'):raise ApprovalRequired('Scene review changed while director was running; paid response retained without reposting')
        conn.execute('INSERT INTO reverse_scene_graphs(id,project_id,version_id,source_sha256,locks_hash,input_hash,graph,review,parent_id,provenance) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
            (ident,project['id'],version['id'],project['source_sha256'],version['locks_hash'],context['input_hash'],Jsonb(graph),Jsonb(review),context.get('parent_graph_id'),Jsonb(provenance)))
    return {'graph_id':ident,'version_id':version['id'],'selection_id':version['selection_id']}


def sampled_indices(timing,events,offset):
    pts=timing['pts'];last=len(pts)-1;indices={0,last}
    for event in events:
        start,end=event['start_s']+offset,event['end_s']+offset
        for t in [start-.15,start,(start+end)/2,end,end+.15]:
            if 0<=t<=timing['end_s']:indices.add(min(last,bisect.bisect_left(pts,t)))
    if len(indices)>64:
        ordered=sorted(indices);indices={ordered[round(i*(len(ordered)-1)/63)] for i in range(64)}
    target=min(64,len(pts),max(len(indices),math.ceil(timing['end_s']*8)+1))
    while len(indices)<target:
        ordered=sorted(indices);gaps=[(pts[b]-pts[a],a,b) for a,b in zip(ordered,ordered[1:]) if b-a>1]
        if not gaps:break
        _,a,b=max(gaps);indices.add(min(b-1,max(a+1,bisect.bisect_left(pts,(pts[a]+pts[b])/2))))
    return sorted(indices)


def _mapping(ctx,project,graph,version,asset):
    shot=next((s for s in version['document']['shots'] if s['id']==asset['shot_id']),None)
    if not shot:raise ApprovalRequired('Generated asset does not match a shot in this graph')
    meta=asset.get('metadata') or {}
    if asset['role']=='generated_candidate':
        if any(str(meta.get(k))!=str(v) for k,v in [('graph_id',graph['id']),('version_id',version['id']),('input_hash',graph['input_hash'])]) or not meta.get('rights_confirmed'):
            raise ApprovalRequired('Uploaded candidate is not bound to this graph and version')
        return shot,-shot['start_s'],shot['end_s']-shot['start_s'],'owner_bound_candidate'
    if asset['role'] not in ('generated_shot','generated_raw'):raise ApprovalRequired('Only actual generated shots can be inspected; source footage is not a candidate')
    q=ctx.db.one('SELECT quote FROM reverse_quotes WHERE id=%s AND project_id=%s',(meta.get('quote_id'),project['id']))
    task=next((t for t in (q or {}).get('quote',{}).get('tasks',[]) if t.get('role')=='video' and t.get('shot',{}).get('shot_id')==asset['shot_id']),None)
    selected=ctx.db.one('SELECT evidence FROM reverse_prompt_selections WHERE id=%s AND project_id=%s',(version['selection_id'],project['id']))
    if not task or not selected or not all(k in task.get('measured',{}) for k in ('start_s','end_s')):raise ApprovalRequired('Generated shot has no verified source time mapping')
    binding=q['quote'].get('scene_logic') or {}
    if any(binding.get(k)!=v for k,v in [('graph_id',graph['id']),('version_id',version['id']),('input_hash',graph['input_hash']),('graph_hash',prompts.canonical_hash(graph['graph'])),('review_hash',prompts.canonical_hash(graph.get('review') or {}))]):
        raise ApprovalRequired('Generated shot belongs to another scene graph or prompt version; explicitly upload it as a candidate to inspect against this graph')
    offset=selected['evidence']['start_s']-task['measured']['start_s']
    if shot['start_s']+offset<-.001 or shot['end_s']+selected['evidence']['start_s']>task['measured']['end_s']+.001:raise ApprovalRequired('Source selection lies outside the generated shot time mapping')
    return shot,offset,task.get('delivery',{}).get('duration_s',task['measured']['end_s']-task['measured']['start_s']),'generation_quote_measured_interval'


def prepare_inspection(ctx,project,spec):
    row=ctx.db.one('SELECT * FROM reverse_inspection_evidence WHERE id=%s AND project_id=%s',(spec['evidence_id'],project['id']))
    if not row:raise ValueError('Inspection preparation not found')
    if row.get('evidence'):return {'evidence_id':row['id'],'cached':True,'paid_requests':0}
    graph=ctx.db.one('SELECT * FROM reverse_scene_graphs WHERE id=%s AND project_id=%s',(row['graph_id'],project['id']))
    version=ctx.db.one('SELECT * FROM reverse_prompt_versions WHERE id=%s AND project_id=%s',(graph['version_id'],project['id']))
    asset=ctx.db.one('SELECT * FROM reverse_assets WHERE id=%s AND project_id=%s',(row['asset_id'],project['id']))
    if not asset or asset['sha256']!=row['asset_sha256']:raise ApprovalRequired('Generated asset binding changed')
    shot,offset,expected,mapping=_mapping(ctx,project,graph,version,asset)
    report(ctx,'inspect_measure','กำลังวัดคลิปที่สร้างจริง',detail='เตรียมภาพและช่วงเวลาของการกระทำ ยังไม่มีค่า AI')
    path=fetch_private(ctx,asset,ctx.path('inspection','generated.mp4'))
    if file_sha(path)!=row['asset_sha256']:raise ApprovalRequired('Generated file checksum mismatch')
    timing=frame_timing(path)
    if not 0<timing['end_s']<=60:raise ValueError('Inspect one generated shot up to 60 seconds')
    events=[e for e in graph['graph']['events'] if e['shot_id']==shot['id']]
    indices=sampled_indices(timing,events,offset);folder=Path(ctx.path('inspection','frames'));folder.mkdir(parents=True,exist_ok=True)
    expr='+'.join('eq(n\\,'+str(i)+')' for i in indices)
    ffmpeg(['-i',path,'-vf',"select='"+expr+"',scale=768:768:force_original_aspect_ratio=decrease",'-vsync','0','-q:v','3',folder/'frame-%03d.jpg'])
    files=sorted(folder.glob('frame-*.jpg'))
    if len(files)!=len(indices):raise ValueError('Generated inspection frame count mismatch')
    evidence={'asset_id':str(asset['id']),'asset_sha256':asset['sha256'],'graph_id':graph['id'],'version_id':version['id'],'input_hash':graph['input_hash'],'inspected_shot_id':shot['id'],'duration_s':timing['end_s'],'expected_duration_s':expected,'event_time_offset_s':offset,'mapping':mapping,'timing_mismatch':abs(timing['end_s']-expected)>.1,'frames':[],'temporal_windows':[],'sampling':'event boundaries +/- 0.15s and measured-gap fill, maximum 64 frames; model sees timestamped stills, not native video'}
    for count,(idx,file) in enumerate(zip(indices,files),1):
        check_active(ctx);saved=save_private(ctx,project['id'],file,'inspection_frame',shot_id=shot['id'],content_type='image/jpeg',metadata={'parent_asset_id':str(asset['id']),'evidence_id':row['id'],'frame':idx,'at_s':timing['pts'][idx]})
        evidence['frames'].append({'frame':idx,'at_s':timing['pts'][idx],'asset_id':str(saved['id']),'sha256':saved['sha256']})
        report(ctx,'inspect_frames','กำลังเก็บภาพจากคลิปที่สร้าง',completed=count,total=len(indices)+len(events)+1,mode='work_units')
    for count,event in enumerate(events):
        start=max(0,event['start_s']+offset-.2);end=min(timing['end_s'],event['end_s']+offset+.2)
        window={'event_id':event['id'],'start_s':start,'end_s':end,'frame_indices':[f['frame'] for f in evidence['frames'] if start<=f['at_s']<=end]}
        if end>start and count<16:
            segment=ctx.path('inspection','event-'+str(count)+'.mp4');ffmpeg(['-i',path,'-vf',f'trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS','-an','-c:v','libx264','-preset','fast','-crf','24','-movflags','+faststart',segment])
            saved=save_private(ctx,project['id'],segment,'inspection_segment',shot_id=shot['id'],content_type='video/mp4',metadata={'parent_asset_id':str(asset['id']),'evidence_id':row['id'],'event_id':event['id'],'start_s':start,'end_s':end});window['clip_asset_id']=str(saved['id'])
        evidence['temporal_windows'].append(window)
    ctx.db.q('UPDATE reverse_inspection_evidence SET evidence=%s WHERE id=%s AND evidence IS NULL',(Jsonb(evidence),row['id']))
    report(ctx,'inspection_prepared','ภาพสำหรับตรวจวิดีโอพร้อมแล้ว',completed=1,total=1,mode='work_units')
    return {'evidence_id':row['id'],'asset_id':str(asset['id']),'frames':len(indices),'paid_requests':0}


def validate_inspection(raw,graph,evidence,authorized_overrides=None):
    jsonschema.validate(raw,output_schema('video_inspection'));value=copy.deepcopy(raw)
    events={e['id']:e for e in graph['events'] if e['shot_id']==evidence['inspected_shot_id']};seen=set()
    creative={o['event_id'] for o in (authorized_overrides or [])}
    if not events:raise ValueError('No graph events for inspected shot')
    for finding in value['findings']:
        if not math.isfinite(finding['confidence']):raise ValueError('Invalid inspection confidence')
        event=events.get(finding['event_id'])
        if not event or finding['shot_id']!=event['shot_id'] or finding['event_id'] in seen:raise ValueError('Unknown, duplicate or wrong-shot inspection event')
        seen.add(event['id']);citations(finding['evidence'],evidence)
        start,end=event['start_s']+evidence['event_time_offset_s'],event['end_s']+evidence['event_time_offset_s']
        if finding['status']!='uncertain' and (not temporal_support(finding['evidence'],evidence,start,end,cover=True) or evidence['timing_mismatch'] or event['basis']!='observed' and event['id'] not in creative):
            finding['status']='uncertain';finding['uncertainty']+=' The sampled temporal coverage, expected event, or duration mapping is insufficient to confirm this result.'
    for ident in events.keys()-seen:
        event=events[ident];value['findings'].append({'event_id':ident,'shot_id':event['shot_id'],'status':'uncertain','issue_type':'source_fidelity','severity':'warning','evidence':[],'explanation':'The model did not evaluate this required event.','suggested_fix':'Inspect the event interval before deciding whether to regenerate.','confidence':0,'uncertainty':'Missing inspection result is not a passed event.'})
    value['status']='failed' if any(f['status']=='failed' for f in value['findings']) else 'uncertain' if any(f['status']!='passed' for f in value['findings']) else 'passed'
    return value


def inspect(ctx,project,task,quote):
    context=task['payload']['context'];version=_version(ctx,project,context)
    row=ctx.db.one('SELECT * FROM reverse_inspection_evidence WHERE id=%s AND project_id=%s',(context['evidence_id'],project['id']))
    graph=ctx.db.one('SELECT * FROM reverse_scene_graphs WHERE id=%s AND project_id=%s',(context['graph_id'],project['id']))
    asset=ctx.db.one('SELECT * FROM reverse_assets WHERE id=%s AND project_id=%s',(context['asset_id'],project['id']))
    if not row or not graph or not asset or row['evidence']!=task['payload']['evidence'] or str(row['graph_id'])!=context['graph_id'] or graph['graph']!=context['graph'] or graph['version_id']!=version['id'] or graph['input_hash']!=context['input_hash'] or asset['sha256']!=context['asset_sha256'] or str(row['asset_id'])!=context['asset_id'] or row['asset_sha256']!=asset['sha256']:
        raise ApprovalRequired('Inspection graph, generated asset or prepared frames changed')
    latest=ctx.db.one('SELECT id FROM reverse_scene_graphs WHERE project_id=%s AND version_id=%s AND input_hash=%s ORDER BY created_at DESC,id DESC LIMIT 1',(project['id'],graph['version_id'],graph['input_hash']))
    if not latest or latest['id']!=graph['id'] or prompts.canonical_hash(graph['graph'])!=context['graph_hash'] or prompts.canonical_hash(graph['review'])!=context['review_hash']:raise ApprovalRequired('Scene review changed before inspection dispatch')
    _graph_gate(graph)
    _mapping(ctx,project,graph,version,asset)
    ident=prompts.canonical_hash({'inspection_quote':quote['id'],'evidence':row['id']})
    if ctx.db.one('SELECT id FROM reverse_video_inspections WHERE id=%s',(ident,)):return {'inspection_id':ident,'cached':True}
    report(ctx,'inspect_video','Sol กำลังตรวจเหตุการณ์ในวิดีโอที่สร้างจริง')
    paid=prompts.response_call(ctx,project,task,quote);value=validate_inspection(_parsed(paid),graph['graph'],row['evidence'],graph['review'].get('overrides',[]) if graph['review'].get('approved') and not graph['review'].get('requires_revalidation') else [])
    provenance={'model':task['model'],'quote_id':quote['id'],'response_asset_id':paid['response_asset_id'],'provider_id':paid['provider_id'],'basis':'timestamped_generated_frames','automatic_regeneration':False,'recommended_shots':sorted({f['shot_id'] for f in value['findings'] if f['status']=='failed' and f['severity']=='critical'})}
    ctx.db.q('INSERT INTO reverse_video_inspections(id,project_id,graph_id,version_id,asset_id,asset_sha256,evidence_id,report,provenance) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(ident,project['id'],graph['id'],version['id'],asset['id'],asset['sha256'],row['id'],Jsonb(value),Jsonb(provenance)))
    return {'inspection_id':ident,'graph_id':graph['id'],'asset_id':str(asset['id']),'status':value['status'],'automatic_regeneration':False}
