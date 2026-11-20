"""Narrative/temporal contracts with explicit model fixtures and real local media.

No fixture is evidence of semantic model accuracy; no provider is contacted.
"""
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from motion_worker import reverse_scene_logic as logic, reverse_prompts as prompts
from motion_worker import reverse_media as media
from motion_worker.text_video import ApprovalRequired


def fixture():
    actions=[
        {'t0':0,'t1':1,'text':'[C1] collides with [C2].'},
        {'t0':1,'t1':2,'text':'The wallet accidentally slips from [C1] and falls.'},
        {'t0':2,'t1':3,'text':'The wallet remains on the floor after the cut.'},
        {'t0':3,'t1':4,'text':'[C2] turns toward the wallet and notices it.'},
    ]
    shots=[]
    for i in range(2):
        shots.append({'id':f'shot_00{i+1}','start_s':i*2,'end_s':i*2+2,'location_id':'L1',
                      'opening':'[C1] and [C2] in [L1].','actions':actions[i*2:i*2+2],
                      'ending':'Both remain in [L1].','camera':'Locked shot.','lighting':'Daylight.',
                      'style':'Live action.','props':'One wallet.'})
    doc={'duration_s':4,'characters':[{'id':'C1','description':'adult woman'},{'id':'C2','description':'adult man'}],
         'locations':[{'id':'L1','description':'a corridor'}],'shots':shots,'compatibility':['Walkable floor.']}
    times=[0,.5,1,1.5,1.95,2,2.5,2.95,3,3.5,3.95]
    evidence={'frames':[{'frame':i,'at_s':t,'asset_id':f'frame-{i}','sha256':str(i)*64} for i,t in enumerate(times)]}
    def refs(*indices):return [{'frame_index':i,'at_s':times[i],'observation':f'Observed frame at {times[i]}.'} for i in indices]
    events=[]
    for i,(mode,indices) in enumerate([('collision',(0,2)),('accidental',(2,4)),('unknown',(5,7)),('reaction',(8,10))]):
        events.append({'id':f'E{i+1}','shot_id':shots[i//2]['id'],'start_s':i,'end_s':i+1,
                       'actor_ids':['C1','C2'] if i==0 else ['C1'] if i==1 else ['C2'],
                       'object_ids':['O1'],'action':actions[i]['text'],'mode':mode,'basis':'observed',
                       'source_action_indices':[i%2],'evidence':refs(*indices),'uncertainty':''})
    graph={'summary':'Collision causes an accidental wallet drop, followed by discovery.', 'events':events,
           'dependencies':[{'from':f'E{i}','to':f'E{i+1}','relation':'causes' if i==1 else 'before','basis':'observed','explanation':'Source event order.'} for i in range(1,4)],
           'objects':[{'id':'O1','description':'the wallet','states':[
               {'event_id':'E1','owner_id':'C1','placement':'in hand','visibility':'visible','basis':'observed','uncertainty':''},
               {'event_id':'E3','owner_id':'C1','placement':'on the floor after the cut','visibility':'visible','basis':'observed','uncertainty':''}]}],
           'spatial':[{'event_id':'E4','character_id':'C2','position':'right side','orientation':'toward floor','gaze':'toward O1',
                       'field_of_view':'approximate forward view','distance':'nearby','visible_objects':['O1'],'occlusions':[],
                       'knowledge':'C2 can now see O1; earlier awareness is unknown.','basis':'observed','uncertainty':''}],
           'issues':[]}
    return doc,graph,evidence


def inspection_evidence(evidence,shot_id='shot_001'):
    return {**copy.deepcopy(evidence),'inspected_shot_id':shot_id,'event_time_offset_s':0,'timing_mismatch':False}


def inspection(graph,status='passed'):
    return {'status':status,'summary':'Explicit simulated model response.', 'findings':[
        {'event_id':e['id'],'shot_id':e['shot_id'],'status':status,'issue_type':'cause_effect','severity':'critical',
         'evidence':copy.deepcopy(e['evidence']),'explanation':'Observed action differs from the expected causal event.' if status=='failed' else 'Expected event is covered.',
         'suggested_fix':'Regenerate only this shot after approval.' if status=='failed' else '', 'confidence':.9,'uncertainty':''}
        for e in graph['events'] if e['shot_id']=='shot_001']}


def context(tmp_path):
    def path(*parts):
        value=tmp_path.joinpath(*parts);value.parent.mkdir(parents=True,exist_ok=True);return str(value)
    return SimpleNamespace(path=path,job={'id':'job','stage_results':{}},db=SimpleNamespace(one=Mock(),q=Mock(),lock=MagicMock(),conn=MagicMock()))


def test_worker_schema_matches_published_api_schema_exactly():
    source=Path(__file__).resolve().parents[2]/'api/config/scene-logic-schema.json'
    assert logic.schemas()==json.loads(source.read_text())


def test_truncated_scene_response_is_not_salvaged_or_resubmitted():
    partial={'response':{'status':'incomplete','incomplete_details':{'reason':'max_output_tokens'},
                         'output':[{'content':[{'type':'output_text','text':'{"events": []}'}]}]}}
    with patch.object(prompts,'response_call') as submit:
        with pytest.raises(ValueError,match='max_output_tokens'):
            logic._parsed(partial)
        submit.assert_not_called()


def test_refusal_and_invalid_json_are_distinct_safe_errors():
    for response,expected in [
        ({'status':'completed','output':[{'content':[{'type':'refusal','refusal':'private provider text'}]}]},'ปฏิเสธ'),
        ({'status':'completed','output':[{'content':[{'type':'output_text','text':'PRIVATE broken JSON'}]}]},'JSON'),
        ({'status':'failed','error':{'message':'private provider text'}},'ไม่สำเร็จ'),
    ]:
        with pytest.raises(ValueError,match=expected) as error:logic._parsed({'response':response})
        assert 'private' not in str(error.value).lower()
    assert logic._parsed({'response':{'status':'completed','output':[{'content':[{'type':'output_text','text':'{"ok":true}'}]}]}})=={'ok':True}


@pytest.mark.parametrize('mode,action',[('accidental','The wallet accidentally slips from [C1].'),('deliberate','[C1] deliberately places the wallet on the floor.')])
def test_validation_preserves_drop_vs_placement_without_rewriting(mode,action):
    doc,graph,evidence=fixture();graph['events'][1].update(mode=mode,action=action)
    before=copy.deepcopy(graph);result=logic.validate_graph(graph,doc,evidence)
    assert result['events'][1]['mode']==mode and result['events'][1]['action']==action
    assert graph==before


@pytest.mark.parametrize('mode,action',[('collision','[C1] collides with [C2].'),('movement','[C1] approaches [C2] without contact.')])
def test_collision_is_not_silently_converted_to_ordinary_approach(mode,action):
    doc,graph,evidence=fixture();graph['events'][0].update(mode=mode,action=action)
    result=logic.validate_graph(graph,doc,evidence)
    assert result['events'][0]['mode']==mode and result['events'][0]['action']==action


@pytest.mark.parametrize('gaze,visible',[('toward O1',['O1']),('away from O1',[])])
def test_awareness_and_cross_cut_object_state_remain_explicit(gaze,visible):
    doc,graph,evidence=fixture();graph['spatial'][0].update(gaze=gaze,visible_objects=visible)
    result=logic.validate_graph(graph,doc,evidence)
    assert result['spatial'][0]['gaze']==gaze and result['spatial'][0]['visible_objects']==visible
    assert 'approximate' in result['spatial'][0]['uncertainty']
    assert logic.validate_graph(result,doc,evidence)['spatial'][0]['uncertainty']==result['spatial'][0]['uncertainty']
    assert result['objects'][0]['states'][1]['placement']=='on the floor after the cut'
    bad=copy.deepcopy(graph);bad['objects'][0]['states'][1]['owner_id']='C999'
    with pytest.raises(ValueError,match='object continuity'):logic.validate_graph(bad,doc,evidence)


def test_missing_source_actions_invalid_dependencies_and_cycles_are_rejected():
    doc,graph,evidence=fixture();missing=copy.deepcopy(graph);missing['events'].pop(1)
    with pytest.raises(ValueError,match='omitted source actions'):logic.validate_graph(missing,doc,evidence)
    reversed_graph=copy.deepcopy(graph);reversed_graph['dependencies']=[{'from':'E2','to':'E1','relation':'causes','basis':'observed','explanation':'Wrong order.'}]
    with pytest.raises(ValueError,match='reverses source time'):logic.validate_graph(reversed_graph,doc,evidence)
    cyclic=copy.deepcopy(graph);cyclic['events'][1]['start_s']=0
    doc['shots'][0]['actions'][1]['t0']=0 # simultaneous events isolate DAG rejection
    cyclic['dependencies']=[{'from':'E1','to':'E2','relation':'causes','basis':'observed','explanation':'Forward.'}, {'from':'E2','to':'E1','relation':'causes','basis':'observed','explanation':'Back.'}]
    with pytest.raises(ValueError,match='cycle'):logic.validate_graph(cyclic,doc,evidence)


def test_single_frame_temporal_claims_are_inferred_and_fabricated_timestamps_rejected():
    doc,graph,evidence=fixture();graph['events'][0]['evidence']=graph['events'][0]['evidence'][:1]
    result=logic.validate_graph(graph,doc,evidence)
    assert result['events'][0]['basis']=='inferred';assert result['dependencies'][0]['basis']=='inferred'
    bad=copy.deepcopy(graph);bad['events'][0]['evidence'][0]['at_s']=.123
    with pytest.raises(ValueError,match='not a measured frame'):logic.validate_graph(bad,doc,evidence)
    bad=copy.deepcopy(graph);bad['events'][0]['evidence'][0]['frame_index']=999
    with pytest.raises(ValueError,match='not a measured frame'):logic.validate_graph(bad,doc,evidence)


def test_generated_contradiction_fails_only_with_temporal_coverage_and_never_regenerates():
    _,graph,evidence=fixture();raw=inspection(graph,'failed');raw['findings'][1]['explanation']='The woman deliberately places the wallet; expected an accidental drop.'
    result=logic.validate_inspection(raw,graph,inspection_evidence(evidence))
    assert result['status']=='failed' and result['findings'][1]['status']=='failed'
    assert result['findings'][1]['suggested_fix']=='Regenerate only this shot after approval.'
    # No dispatch/callback exists on this pure validator. Missing or duplicate
    # evidence is uncertainty, not a pass and not an automatic paid repair.
    for refs in [[], raw['findings'][0]['evidence'][:1], [raw['findings'][0]['evidence'][0]]*2]:
        sparse=copy.deepcopy(raw);sparse['findings'][0]['evidence']=refs
        out=logic.validate_inspection(sparse,graph,inspection_evidence(evidence))
        assert out['findings'][0]['status']=='uncertain'


def test_irrelevant_or_duplicate_images_do_not_prove_temporal_events():
    _,graph,evidence=fixture();raw=inspection(graph)
    raw['findings'][0]['evidence']=copy.deepcopy(graph['events'][3]['evidence'])
    assert logic.validate_inspection(raw,graph,inspection_evidence(evidence))['findings'][0]['status']=='uncertain'
    raw=inspection(graph);same_asset=inspection_evidence(evidence)
    same_asset['frames'][2]['asset_id']=same_asset['frames'][0]['asset_id']
    assert logic.validate_inspection(raw,graph,same_asset)['findings'][0]['status']=='uncertain'
    raw['findings'][0]['evidence'][0]['at_s']=.125
    with pytest.raises(ValueError,match='not a measured frame'):logic.validate_inspection(raw,graph,inspection_evidence(evidence))


def test_missing_events_unknown_source_or_unaligned_duration_never_become_passed():
    _,graph,evidence=fixture();raw=inspection(graph);raw['findings'].pop()
    result=logic.validate_inspection(raw,graph,inspection_evidence(evidence))
    assert result['status']=='uncertain' and {f['event_id'] for f in result['findings']}=={'E1','E2'}
    assert next(f for f in result['findings'] if f['event_id']=='E2')['status']=='uncertain'
    graph['events'][0]['basis']='unknown'
    assert logic.validate_inspection(inspection(graph),graph,inspection_evidence(evidence))['status']=='uncertain'
    e=inspection_evidence(evidence);e['timing_mismatch']=True
    assert all(f['status']=='uncertain' for f in logic.validate_inspection(inspection(graph),graph,e)['findings'])


def test_source_assets_rejected_and_partial_source_shot_is_mapped_to_output_time(tmp_path):
    ctx=context(tmp_path);doc,graph,_=fixture();version={'id':'v','selection_id':'selected','document':doc};g={'id':'g','input_hash':'h','graph':graph,'review':{}}
    asset={'id':'asset','role':'source','shot_id':'shot_001','metadata':{}}
    with pytest.raises(ApprovalRequired,match='Only actual generated'):logic._mapping(ctx,{'id':'p'},g,version,asset)
    asset.update(role='generated_shot',metadata={'quote_id':'q'})
    binding={'graph_id':'g','version_id':'v','input_hash':'h','graph_hash':prompts.canonical_hash(graph),'review_hash':prompts.canonical_hash({})}
    quote={'quote':{'scene_logic':binding,'tasks':[{'role':'video','shot':{'shot_id':'shot_001'},'measured':{'start_s':10,'end_s':18},'delivery':{'duration_s':8}}]}}
    ctx.db.one.side_effect=lambda sql,args:quote if 'reverse_quotes' in sql else {'evidence':{'start_s':12}}
    shot,offset,duration,mapping=logic._mapping(ctx,{'id':'p'},g,version,asset)
    assert offset==2 and duration==8 and mapping=='generation_quote_measured_interval'
    assert shot['start_s']+offset==2 # selection time 0 maps to generated time 2
    for key in ('graph_id','version_id','input_hash','graph_hash','review_hash'):
        saved=binding[key];binding[key]='different'
        with pytest.raises(ApprovalRequired,match='another scene graph or prompt version'):logic._mapping(ctx,{'id':'p'},g,version,asset)
        binding[key]=saved
    ctx.db.one.side_effect=lambda sql,args: None
    with pytest.raises(ApprovalRequired,match='no verified source time mapping'):logic._mapping(ctx,{'id':'p'},g,version,asset)


@pytest.mark.parametrize('status',['passed','failed'])
def test_inferred_source_is_uncertain_but_explicit_creative_override_is_decidable(status):
    _,graph,evidence=fixture();graph['events'][1]['basis']='inferred'
    raw=inspection(graph,status)
    result=logic.validate_inspection(raw,graph,inspection_evidence(evidence))
    assert result['findings'][1]['status']=='uncertain'
    override={'event_id':'E2','text':graph['events'][1]['action'],'reason':'Owner approved the expected creative action.'}
    approved=logic.validate_inspection(raw,graph,inspection_evidence(evidence),[override])
    assert approved['findings'][1]['status']==status
    sparse=copy.deepcopy(raw);sparse['findings'][1]['evidence']=sparse['findings'][1]['evidence'][:1]
    assert logic.validate_inspection(sparse,graph,inspection_evidence(evidence),[override])['findings'][1]['status']=='uncertain'


def test_uploaded_candidate_requires_graph_version_and_input_binding(tmp_path):
    ctx=context(tmp_path);doc,_,_=fixture();version={'id':'v','selection_id':'selected','document':doc};g={'id':'g','input_hash':'h'}
    asset={'id':'a','role':'generated_candidate','shot_id':'shot_002','metadata':{'graph_id':'g','version_id':'v','input_hash':'h','rights_confirmed':True}}
    _,offset,duration,mapping=logic._mapping(ctx,{'id':'p'},g,version,asset)
    assert offset==-2 and duration==2 and mapping=='owner_bound_candidate'
    for key in ('graph_id','version_id','input_hash','rights_confirmed'):
        bad=copy.deepcopy(asset);bad['metadata'][key]=False
        with pytest.raises(ApprovalRequired,match='not bound'):logic._mapping(ctx,{'id':'p'},g,version,bad)


def test_real_ffmpeg_preparation_samples_actual_generated_frames_and_segments(tmp_path):
    source=tmp_path/'generated.mp4';logic.ffmpeg(['-f','lavfi','-i','testsrc2=s=160x96:r=24:d=2','-c:v','libx264','-pix_fmt','yuv420p',source])
    doc,graph,_=fixture();version={'id':'v','selection_id':'selected','document':doc};g={'id':'g','version_id':'v','input_hash':'h','graph':graph}
    asset={'id':'a','role':'generated_candidate','shot_id':'shot_001','sha256':media.file_sha(source),'metadata':{'graph_id':'g','version_id':'v','input_hash':'h','rights_confirmed':True}}
    row={'id':'input','graph_id':'g','asset_id':'a','asset_sha256':asset['sha256'],'evidence':None};ctx=context(tmp_path/'job')
    def read(sql,args):
        if 'reverse_inspection_evidence' in sql:return row
        if 'reverse_scene_graphs' in sql:return g
        if 'reverse_prompt_versions' in sql:return version
        if 'reverse_assets' in sql:return asset
        raise AssertionError(sql)
    ctx.db.one.side_effect=read;saved=[]
    def save(ctx,pid,path,role,**kwargs):
        assert Path(path).is_file();saved.append((role,Path(path),kwargs))
        return {'id':f'asset-{len(saved)}','sha256':media.file_sha(path)}
    with patch.object(logic,'fetch_private',return_value=source),patch.object(logic,'save_private',side_effect=save),patch.object(logic,'check_active'),patch.object(prompts,'response_call',side_effect=AssertionError('Preparation must never call AI')):
        result=logic.prepare_inspection(ctx,{'id':'p'},{'evidence_id':'input'})
    assert result['paid_requests']==0 and 16<=result['frames']<=48
    written=next(call.args[1][0].obj for call in ctx.db.q.call_args_list if call.args[0].startswith('UPDATE reverse_inspection_evidence'))
    timing=media.frame_timing(source)
    assert written['asset_sha256']==asset['sha256'] and not written['timing_mismatch']
    assert all(f['at_s']==timing['pts'][f['frame']] for f in written['frames'])
    assert len({f['frame'] for f in written['frames']})==len(written['frames'])
    segments=[r for r in saved if r[0]=='inspection_segment'];assert len(segments)==2
    assert all(media.frame_timing(p)['end_s']<=1.5 for _,p,_ in segments)
    assert all(w['clip_asset_id'] and len(w['frame_indices'])>=2 for w in written['temporal_windows'])


def test_sampler_is_bounded_and_keeps_endpoint_evidence():
    timing={'pts':[i/30 for i in range(1800)],'end_s':60}
    events=[{'start_s':i*.5,'end_s':i*.5+.4} for i in range(100)]
    indices=logic.sampled_indices(timing,events,0)
    assert len(indices)==64 and indices==sorted(set(indices))
    assert indices[0]==0 and indices[-1]==1799


def test_owner_override_revalidates_as_creative_intent_without_mutating_source(tmp_path):
    doc,graph,evidence=fixture();ctx=context(tmp_path);original=copy.deepcopy(doc)
    replacements={'characters':{},'locations':{}};input_hash=prompts.canonical_hash({'document':doc,'replacements':replacements,'main_character_id':'C1'})
    version={'id':'version','selection_id':'selection','document':doc,'locks_hash':prompts.motion_lock(doc),'replacements':replacements}
    parent={'id':'parent','version_id':'version','input_hash':input_hash,'graph':copy.deepcopy(graph)}
    override={'event_id':'E2','text':'[C1] deliberately places the wallet on the floor.','reason':'Owner explicitly changes this story beat.'}
    context_value={'version_id':'version','document':doc,'locks_hash':version['locks_hash'],'replacements':replacements,'main_character_id':'C1','input_hash':input_hash,
                   'base_graph_id':'parent','parent_graph_id':'parent','parent_graph':parent['graph'],'authorized_overrides':[override],
                   'review':{'requires_revalidation':True,'overrides':[override],'confirmed_issue_ids':['old-finding'],'dismissed_issue_ids':['old-dismissal']}}
    task={'model':'gpt-6.1-sol','payload':{'context':context_value,'evidence':evidence}}
    def read(sql,args):
        if 'SELECT id FROM reverse_scene_graphs WHERE id=' in sql:return None
        if 'SELECT id FROM reverse_scene_graphs' in sql:return {'id':'parent'}
        if 'reverse_prompt_versions' in sql:return version
        if 'reverse_prompt_selections' in sql:return {'evidence':evidence}
        if 'reverse_scene_graphs' in sql:return parent
        raise AssertionError(sql)
    ctx.db.one.side_effect=read;ctx.db.conn.execute.return_value.fetchone.return_value={'id':'parent'}
    returned=copy.deepcopy(graph);returned['events'][1].update(action=override['text'],mode='deliberate')
    paid={'response':{'status':'completed','output':[{'content':[{'type':'output_text','text':json.dumps(returned)}]}]},'response_asset_id':'response','provider_id':'resp_fixture'}
    with patch.object(prompts,'response_call',return_value=paid) as call:
        result=logic.direct(ctx,{'id':'p','source_sha256':'source'},task,{'id':'quote'})
    saved=next(c.args[1] for c in ctx.db.conn.execute.call_args_list if c.args[0].startswith('INSERT INTO reverse_scene_graphs'))
    assert len(result['graph_id'])==64 and saved[0]==result['graph_id']
    assert saved[6].obj['events'][1]['action']==override['text']
    assert saved[6].obj['events'][1]['basis']=='inferred'
    assert saved[6].obj['dependencies'][0]['basis']=='inferred'
    assert saved[6].obj['dependencies'][1]['basis']=='inferred'
    assert 'Owner-approved creative intent' in saved[6].obj['events'][1]['uncertainty']
    assert saved[7].obj['requires_revalidation'] is False
    assert saved[7].obj['confirmed_issue_ids']==saved[7].obj['dismissed_issue_ids']==[]
    assert saved[7].obj['overrides']==[override] and doc==original
    assert call.call_count==1
    # Approval of E2 is not authorization to alter E1 or its actor/timing.
    for mutation in [lambda g:g['events'][0].update(action='[C1] walks away.'),lambda g:g['events'][1].update(actor_ids=['C2'])]:
        bad=copy.deepcopy(returned);mutation(bad)
        altered=copy.deepcopy(paid);altered['response']['output'][0]['content'][0]['text']=json.dumps(bad)
        with patch.object(prompts,'response_call',return_value=altered),pytest.raises(ValueError,match='Revalidation changed'):
            logic.direct(ctx,{'id':'p','source_sha256':'source'},task,{'id':'quote'})
    # A result that completes after the owner records a newer review is retained
    # in the provider ledger, but must never supersede the owner's state.
    ctx.db.conn.execute.reset_mock();ctx.db.conn.execute.return_value.fetchone.return_value={'id':'new-owner-review'}
    with patch.object(prompts,'response_call',return_value=paid) as cached,pytest.raises(ApprovalRequired,match='while director was running'):
        logic.direct(ctx,{'id':'p','source_sha256':'source'},task,{'id':'quote'})
    assert cached.call_count==1
    assert not any(c.args[0].startswith('INSERT INTO reverse_scene_graphs') for c in ctx.db.conn.execute.call_args_list)


@pytest.mark.parametrize('references',[[1],[1,0,1]])
def test_first_director_result_persists_exact_source_actions_not_model_reinterpretation(tmp_path,references):
    doc,graph,evidence=fixture();original=copy.deepcopy(doc);ctx=context(tmp_path)
    replacements={'characters':{},'locations':{}}
    version={'id':'version','selection_id':'selection','document':doc,'locks_hash':prompts.motion_lock(doc),'replacements':replacements}
    context_value={'version_id':'version','document':doc,'locks_hash':version['locks_hash'],'replacements':replacements,'main_character_id':'C1',
                   'input_hash':prompts.canonical_hash({'document':doc,'replacements':replacements,'main_character_id':'C1'}),'base_graph_id':None}
    task={'model':'gpt-6.1-sol','payload':{'context':context_value,'evidence':evidence}}
    def read(sql,args):
        if 'reverse_prompt_versions' in sql:return version
        if 'reverse_prompt_selections' in sql:return {'evidence':evidence}
        if 'SELECT id FROM reverse_scene_graphs' in sql:return None
        raise AssertionError(sql)
    ctx.db.one.side_effect=read;ctx.db.conn.execute.return_value.fetchone.return_value=None
    graph['events'][1].update(action='[C1] deliberately places the wallet on a table.',mode='deliberate',source_action_indices=references)
    paid={'response':{'status':'completed','output':[{'content':[{'type':'output_text','text':json.dumps(graph)}]}]},'response_asset_id':'response','provider_id':'resp_fixture'}
    with patch.object(prompts,'response_call',return_value=paid) as paid_transport:
        logic.direct(ctx,{'id':'p','source_sha256':'source'},task,{'id':'quote'})
    saved=next(c.args[1] for c in ctx.db.conn.execute.call_args_list if c.args[0].startswith('INSERT INTO reverse_scene_graphs'))
    expected=' '.join(doc['shots'][0]['actions'][i]['text'] for i in sorted(set(references)))
    assert saved[6].obj['events'][1]['action']==expected
    assert 'deliberately' not in saved[6].obj['events'][1]['action']
    assert doc==original and paid_transport.call_count==1


def generation_fixture(tmp_path):
    doc,graph,_=fixture();ctx=context(tmp_path)
    project={'id':'project','source_sha256':'source'};replacements={'characters':{},'locations':{}}
    version={'id':'version','document':doc,'replacements':replacements}
    graph_row={'id':'graph','version_id':'version','source_sha256':'source','locks_hash':prompts.motion_lock(doc),
               'input_hash':prompts.canonical_hash({'document':doc,'replacements':replacements,'main_character_id':'C1'}),
               'graph':graph,'review':{},'provenance':{'main_character_id':'C1'}}
    prompt='The characters collide, accidentally dropping the wallet.'
    binding={k:graph_row[k] for k in ('version_id','input_hash','locks_hash')}
    binding.update(graph_id='graph',graph_hash=prompts.canonical_hash(graph),review_hash=prompts.canonical_hash({}),prompt_hashes={'shot_001':prompts.canonical_hash(prompt)})
    quote={'purpose':'generate','scene_logic':binding,'tasks':[
        {'role':'audio','payload':{'text':'Audio would otherwise be sorted first.'}},
        {'role':'video','shot':{'shot_id':'shot_001','prompt':prompt},'payload':{'prompt':prompt}}]}
    state={'latest':'graph'}
    def read(sql,args):
        if 'SELECT id FROM reverse_scene_graphs' in sql:return {'id':state['latest']}
        if 'reverse_scene_graphs' in sql:return graph_row
        if 'reverse_prompt_versions' in sql:return version
        raise AssertionError(sql)
    ctx.db.one.side_effect=read
    return ctx,project,quote,graph_row,version,state


@pytest.mark.parametrize('basis,confirmed',[('observed',False),('inferred',True)])
def test_generation_preflight_blocks_observed_or_owner_confirmed_critical_before_any_provider(tmp_path,basis,confirmed):
    ctx,project,quote,graph,_,_=generation_fixture(tmp_path)
    graph['graph']['issues']=[{'id':'critical-1','severity':'critical','basis':basis}]
    graph['review']={'confirmed_issue_ids':['critical-1'] if confirmed else []}
    quote['scene_logic'].update(graph_hash=prompts.canonical_hash(graph['graph']),review_hash=prompts.canonical_hash(graph['review']))
    with patch.object(prompts,'response_call',side_effect=AssertionError('Preflight must not call a provider')),pytest.raises(ApprovalRequired,match='Critical scene contradiction'):
        logic.generation_preflight(ctx,project,quote)
    graph['review']['dismissed_issue_ids']=['critical-1'];quote['scene_logic']['review_hash']=prompts.canonical_hash(graph['review'])
    logic.generation_preflight(ctx,project,quote)


def test_generation_preflight_rejects_stale_review_graph_or_replacements_and_changed_prompt(tmp_path):
    ctx,project,quote,graph,version,state=generation_fixture(tmp_path)
    logic.generation_preflight(ctx,project,quote)
    state['latest']='new-graph'
    with pytest.raises(ApprovalRequired,match='Newer scene review'):logic.generation_preflight(ctx,project,quote)
    state['latest']='graph';graph['graph']['summary']='Changed graph result'
    with pytest.raises(ApprovalRequired,match='binding changed'):logic.generation_preflight(ctx,project,quote)
    quote['scene_logic']['graph_hash']=prompts.canonical_hash(graph['graph']);graph['review']['requires_revalidation']=True
    quote['scene_logic']['review_hash']=prompts.canonical_hash(graph['review'])
    with pytest.raises(ApprovalRequired,match='require a new Scene Logic Check'):logic.generation_preflight(ctx,project,quote)
    graph['review']={};quote['scene_logic']['review_hash']=prompts.canonical_hash({})
    version['replacements']['characters']['C1']='a different actor'
    with pytest.raises(ApprovalRequired,match='binding changed'):logic.generation_preflight(ctx,project,quote)
    version['replacements']['characters'].clear()
    quote['tasks'][1]['payload']['prompt']='A completely different paid generation prompt.'
    with pytest.raises(ApprovalRequired,match='prompt differs'):logic.generation_preflight(ctx,project,quote)


def test_focused_workflow_requires_new_bound_quote_but_legacy_projects_remain_usable(tmp_path):
    ctx,project,quote,_,_,_=generation_fixture(tmp_path);quote.pop('scene_logic')
    with pytest.raises(ApprovalRequired,match='fresh bound quote'):logic.generation_preflight(ctx,project,quote)
    ctx.db.one.side_effect=lambda sql,args:None
    logic.generation_preflight(ctx,project,quote)


def test_reverse_dispatch_blocks_audio_and_fal_before_first_paid_task(tmp_path):
    from motion_worker import reverse
    ctx,project,quote,graph,_,_=generation_fixture(tmp_path)
    quote.update(id='quote',binding='approved-binding')
    graph['graph']['issues']=[{'id':'critical-1','severity':'critical','basis':'observed'}]
    quote['scene_logic']['graph_hash']=prompts.canonical_hash(graph['graph'])
    old_read=ctx.db.one.side_effect
    def read(sql,args):
        if 'reverse_projects' in sql:return project
        if 'reverse_approvals' in sql:return {'binding':'approved-binding'}
        return old_read(sql,args)
    ctx.db.one.side_effect=read
    ctx.pkg={'reverse':{'project_id':project['id'],'source_sha256':project['source_sha256'],'action':'generate','quote':quote}}
    with patch.object(reverse,'check_active'),patch.object(reverse,'produce_audio') as audio,patch.object(reverse,'fal_call') as fal:
        with pytest.raises(ApprovalRequired,match='Critical scene contradiction'):reverse.run(ctx)
        assert not audio.called and not fal.called
        # Even a direct/resumed video step rechecks immediately before dispatch.
        with pytest.raises(ApprovalRequired,match='Critical scene contradiction'):reverse.generate(ctx,project,quote['tasks'][1],quote)
        assert not fal.called


def test_new_owner_review_between_tasks_prevents_next_audio_charge(tmp_path):
    from motion_worker import reverse
    ctx,project,quote,graph,_,_=generation_fixture(tmp_path)
    quote.update(id='quote',binding='approved-binding')
    quote['tasks'][0]['slot']='audio:first'
    quote['tasks'].append({'role':'audio','slot':'audio:second','payload':{'text':'Must not be charged after review changes.'}})
    quote['tasks'][1]['slot']='video:shot_001'
    ctx.db.status=Mock();old_read=ctx.db.one.side_effect
    def read(sql,args):
        if 'reverse_projects' in sql:return project
        if 'reverse_approvals' in sql:return {'binding':'approved-binding'}
        if 'reverse_steps' in sql:return None
        return old_read(sql,args)
    ctx.db.one.side_effect=read
    ctx.pkg={'reverse':{'project_id':project['id'],'source_sha256':project['source_sha256'],'action':'generate','quote':quote}}
    def first_audio(*args):
        graph['review']['confirmed_issue_ids']=['new-review-finding']
        return {'asset_id':'first-approved-audio'}
    with patch.object(reverse,'check_active'),patch.object(reverse,'produce_audio',side_effect=first_audio) as audio,patch.object(reverse,'fal_call') as fal:
        with pytest.raises(ApprovalRequired,match='binding changed'):reverse.run(ctx)
        assert audio.call_count==1 and not fal.called


def test_guided_dispatch_rechecks_current_prompt_version_and_exact_payload(tmp_path):
    ctx,project,quote,graph,version,_=generation_fixture(tmp_path)
    version['selection_id']='selection'
    payload={'prompt':'Locked original action','duration':2,'aspect_ratio':'16:9'}
    quote.update(purpose='prompt_video',tasks=[{'role':'prompt_video','endpoint':'minimax/h3-max/text-to-video','payload':payload}])
    quote['scene_logic'].update(variant='b',payload_hash=prompts.canonical_hash(payload))
    original_read=ctx.db.one.side_effect
    selected={'id':version['id']}
    def read(sql,args):
        if 'SELECT id,locks_hash FROM reverse_prompt_versions' in sql:return {'id':'original','locks_hash':graph['locks_hash']}
        if 'SELECT id FROM reverse_prompt_versions' in sql:return selected
        return original_read(sql,args)
    ctx.db.one.side_effect=read
    logic.generation_preflight(ctx,project,quote)
    selected['id']='edited-in-another-tab'
    with pytest.raises(ApprovalRequired,match='newer'):logic.generation_preflight(ctx,project,quote)
    selected['id']=version['id'];payload['prompt']='changed'
    with pytest.raises(ApprovalRequired,match='differs'):logic.generation_preflight(ctx,project,quote)
