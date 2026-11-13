"""No paid providers. Local media is synthetic verification, never semantic evidence."""
import copy
import json
import os
import threading
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import pytest
import requests
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from motion_worker import reverse,reverse_provider,reverse_runtime,reverse_media,reverse_render
from motion_worker.creative_ledger import Ledger,AmbiguousCall
from motion_worker.storage import LocalStorage
from motion_worker.text_video import ApprovalRequired


def test_real_runtime_never_inherits_provider_credentials(tmp_path,monkeypatch):
    for key in ['FAL_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','ELEVENLABS_API_KEY','MOTION_INTERNAL_TOKEN','AWS_SECRET_ACCESS_KEY']:
        monkeypatch.setenv(key,'must-not-leave-worker')
    env=reverse_runtime.environment(tmp_path)
    assert all(k not in env for k in ['FAL_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','ELEVENLABS_API_KEY','MOTION_INTERNAL_TOKEN','AWS_SECRET_ACCESS_KEY'])
    assert env['DOTENV_PATH'].endswith('no-provider-credentials.env')
    with pytest.raises(ValueError):reverse_runtime.decompose(tmp_path/'source.mp4',tmp_path)


def test_aes_roundtrip_checksum_and_tamper_rejection(tmp_path,monkeypatch):
    monkeypatch.setenv('MOTION_REVERSE_STORAGE_KEY','7a'*32)
    source=tmp_path/'source.mp4';source.write_bytes(b'original confidential bytes'*100)
    class DB:
        def one(self,sql,args):
            keys=['id','project_id','shot_id','role','storage_key','sha256','bytes','content_type','encryption','metadata']
            return {k:(v.obj if hasattr(v,'obj') else v) for k,v in zip(keys,args)}
    ctx=SimpleNamespace(store=LocalStorage(str(tmp_path/'bucket')),db=DB())
    with patch('motion_worker.r2.enabled',return_value=False):asset=reverse_media.save_private(ctx,'project',source,'source')
    ciphertext=(tmp_path/'bucket'/asset['storage_key']).read_bytes();assert source.read_bytes() not in ciphertext
    output=reverse_media.fetch_private(ctx,asset,tmp_path/'restored.mp4');assert output.read_bytes()==source.read_bytes()
    tampered=bytearray(ciphertext);tampered[0]^=1;(tmp_path/'bucket'/asset['storage_key']).write_bytes(tampered)
    with pytest.raises(Exception):reverse_media.fetch_private(ctx,asset,tmp_path/'tampered.mp4')
    assert not(tmp_path/'tampered.mp4').exists()


def test_ledger_accepted_fal_id_resumes_but_unknown_post_stays_blocked():
    old={'provider':'fal','provider_id':'accepted-id','status':'uncertain','request_hash':'same','result':None}
    class Conn:
        def transaction(self):return nullcontext()
        def execute(self,sql,args):
            value={'status':'RUNNING','package':{}} if 'SELECT status,package' in sql else {'max_usd':1,'allocations':{'vision':1}} if 'SELECT * FROM creative_approvals' in sql else old
            return SimpleNamespace(fetchone=lambda:value)
    ctx=SimpleNamespace(db=SimpleNamespace(lock=threading.Lock(),conn=Conn()),job={'id':'job'})
    with patch('motion_worker.creative_ledger.digest',return_value='same'):
        assert Ledger(ctx).reserve('k','fal','openrouter/router/video','vision',{},.1)['provider_id']=='accepted-id'
        old['provider_id']=None
        with pytest.raises(AmbiguousCall):Ledger(ctx).reserve('k','fal','openrouter/router/video','vision',{},.1)
        old['request_hash']='changed'
        with pytest.raises(RuntimeError,match='changed request'):Ledger(ctx).reserve('k','fal','model','vision',{},.1)


def test_paid_post_disconnect_is_single_attempt_and_accepted_resume_only_gets(tmp_path,monkeypatch):
    monkeypatch.setenv('FAL_KEY','fixture-key')
    task={'slot':'vision:shot_001','endpoint':'openrouter/router/video','role':'vision','model':'google/gemini-3.8-flash','category':'vision','usd':.1,'payload':{},'clip':{'asset_id':'clip'}}
    quote={'binding':'binding','key_fingerprints':{'fal':reverse_provider.fingerprint('FAL_KEY')},'valid_until':'2099-01-01T00:00:00+00:00','id':'quote','revision':'none'}
    ctx=SimpleNamespace(db=SimpleNamespace(one=Mock(return_value=None),q=Mock()),job={'id':'job'},path=lambda *p:str(tmp_path.joinpath(*p)))
    row={'id':'call','status':'started','provider_id':None};project={'id':'project','source_sha256':'a'*64}
    with patch.object(reverse_provider,'check_active'),patch.object(reverse_provider,'verify_price'),patch.object(reverse_provider,'asset_uri',return_value='data:video/mp4;base64,AA=='),patch.object(Ledger,'reserve',return_value=row),patch.object(requests,'post',side_effect=requests.ReadTimeout('lost')) as post:
        with pytest.raises(requests.ReadTimeout):reverse_provider._fal_call(ctx,project,task,quote)
        assert post.call_count==1;assert any('uncertain' in c.args[0] for c in ctx.db.q.call_args_list)
    accepted={**row,'provider_id':'saved-id','usage':{'status_url':'https://queue.fal.run/openrouter/requests/saved-id/status','response_url':'https://queue.fal.run/openrouter/requests/saved-id'}}
    ctx.db.one.return_value=accepted
    class Response:
        ok=True
        def __init__(self,value):self.value=value
        def json(self):return self.value
        def raise_for_status(self):pass
    (tmp_path/'provider').mkdir()
    with patch.object(reverse_provider,'check_active'),patch.object(Ledger,'reserve',return_value=accepted),patch.object(reverse_provider,'save_private',return_value={'id':'result'}),patch.object(requests,'post') as post,patch.object(requests,'get',side_effect=[Response({'status':'COMPLETED'}),Response({'output':'real response transport fixture','usage':{'cost':.001}})]) as get:
        result=reverse_provider._fal_call(ctx,project,task,quote)
        assert not post.called;assert get.call_count==2;assert result['provider_id']=='saved-id'


def test_source_frame_boundaries_and_local_assembly_are_measured(tmp_path):
    source=tmp_path/'source.mp4';reverse_render.ffmpeg(['-f','lavfi','-i','testsrc2=s=180x320:r=24:d=2','-c:v','libx264','-pix_fmt','yuv420p',source])
    raw={'shots':[{'id':'shot_001','start':0,'end':1,'start_frame':0,'end_frame':24},{'id':'shot_002','start':1,'end':2,'start_frame':24,'end_frame':48}]}
    a=reverse_media.normalized_analysis(raw,source)
    assert len(a['shots'])==2;assert a['shots'][0]['end_s']==a['shots'][1]['start_s'];assert a['shots'][0]['semantic'] is None
    out=reverse_media.clip(source,a['shots'][0],tmp_path/'clip.mp4');assert out['frame_count']==24;assert out['stretch']==8;assert out['audio_included'] is False
    broken=copy.deepcopy(raw);broken['shots'][1]['start_frame']=25
    with pytest.raises(ValueError,match='gap'):reverse_media.normalized_analysis(broken,source)
    g={'background':'#234567','layers':[{'kind':'text','text':'ทดสอบ A','x':.1,'y':.3,'width':.8,'height':.2,'size':80,'color':'#ffffff','from':0,'to':1,'enter':0,'exit':1,'motion':'fade'}]}
    parts=[]
    tone=tmp_path/'tone.wav';reverse_render.ffmpeg(['-f','lavfi','-i','sine=frequency=440:duration=1',tone])
    text='ทดสอบ';n=len(text);alignment={'characters':list(text),'character_start_times_seconds':[i*.8/n for i in range(n)],'character_end_times_seconds':[(i+1)*.8/n for i in range(n)]}
    cues=reverse_render.subtitles(alignment,{'text':text,'start_s':.1},1)
    overlay=tmp_path/'subtitle.mov';reverse_render.code_motion({'background':'#000000','layers':[]},overlay,1,180,320,transparent=True,cues=cues)
    for i in range(2):
        raw=tmp_path/f'raw{i}.mp4';final=tmp_path/f'part{i}.mp4';reverse_render.code_motion(g,raw,1,180,320);reverse_render.compose(raw,final,1,[{'path':tone,'duration_s':1,'start_s':0,'gain':.5}],overlay=overlay);parts.append(final)
    output=reverse_render.assemble(parts,tmp_path/'final.mp4',tmp_path);qa=reverse_render.technical_qa(output,2,180,320,audio_expected=True)
    assert qa['ok'];assert qa['audio_present'];assert qa['visual_review']=='not_run'
    assert qa['true_peak_dbfs'] is not None and qa['true_peak_dbfs']<0;assert qa['integrated_loudness_lufs'] is not None
    mismatch=reverse_render.technical_qa(output,9,180,320);assert not mismatch['ok']
    short=tmp_path/'new-generated-short.mp4';fixed=tmp_path/'new-generated-fixed.mp4'
    reverse_render.ffmpeg(['-i',tmp_path/'raw0.mp4','-frames:v','29','-an','-c:v','copy',short])
    reverse_render.normalize(short,fixed,1,180,320)
    assert int(next(s for s in reverse_media.probe(fixed)['streams'] if s['codec_type']=='video')['nb_frames'])==30


def test_subtitles_use_actual_alignment_and_refuse_fabricated_or_outside_timing():
    task={'text':'hello','start_s':.2};align={'characters':list('hello'),'character_start_times_seconds':[0,.1,.2,.3,.4],'character_end_times_seconds':[.1,.2,.3,.4,.5]}
    cues=reverse_render.subtitles(align,task,1);assert cues[0]['start']==.2;assert cues[0]['end']==.7
    with pytest.raises(ValueError):reverse_render.subtitles(align,{'text':'different','start_s':0},1)
    with pytest.raises(ValueError):reverse_render.subtitles(align,task,.3)
    prompt=reverse.source_prompt({'characters':[],'location':{'description':'Owner test fixture'},'objects':[],'starting_state':'Opening','ending_state':'Closing','character_actions':[{'t0':0,'t1':1.25,'text':'Action'}],'camera':{'framing':'Wide','angle':'Level','motion':'Locked'},'lighting':'Soft','visual_style':'Test fixture'},{'duration_s':1.25})
    assert '1.250000 seconds' in prompt and '0.000000–1.250000s' in prompt


def test_audio_cache_identity_ignores_mix_gain_offset_and_speech_slot(monkeypatch):
    from motion_worker import reverse_audio
    monkeypatch.delenv('MOTION_FAKE_ELEVEN',raising=False)
    task={'category':'narration','model':'eleven_v4','usd':.1,'shot_id':'shot_001','payload':{'id':'narration','role':'narration','text':'สวัสดี','model':'eleven_v4','voice_id':'same-voice','start_s':0,'duration_s':2,'gain':.8}}
    quote={'key_fingerprints':{'eleven':reverse_audio.fingerprint('ELEVENLABS_API_KEY')},'valid_until':'2099-01-01T00:00:00+00:00'}
    with patch.object(reverse_audio,'check_active'),patch.object(reverse_audio,'cached_call',return_value={'duration_s':1}) as cache:
        reverse_audio.produce_audio(SimpleNamespace(),{'id':'project'},task,quote);first=cache.call_args.args[3]
        task['payload'].update(start_s=1,duration_s=3,gain=.3)
        reverse_audio.produce_audio(SimpleNamespace(),{'id':'project'},task,quote);second=cache.call_args.args[3]
    assert first==second


def test_selected_repair_schedules_no_other_shots():
    task={'slot':'video:shot_002','role':'video','shot_id':'shot_002','provider':'local'}
    quote={'id':'quote','binding':'binding','tasks':[task]}
    spec={'project_id':'project','source_sha256':'a'*64,'action':'repair','quote':quote}
    project={'id':'project','source_sha256':'a'*64}
    def one(sql,args):
        if 'reverse_projects' in sql:return project
        if 'reverse_approvals' in sql:return {'binding':'binding'}
        return None
    ctx=SimpleNamespace(pkg={'reverse':spec},job={'id':'job'},db=SimpleNamespace(one=one,q=Mock(),status=Mock()))
    with patch.object(reverse,'check_active'),patch.object(reverse,'generate',return_value={'shot_id':'shot_002','asset_id':'new-one'}) as generate:
        result=reverse.run(ctx)
    assert generate.call_count==1;assert result['steps']==[{'shot_id':'shot_002','asset_id':'new-one'}]


@pytest.mark.skipif(not os.environ.get('MOTION_CAPSULE_ROOT'),reason='actual upstream path not supplied')
def test_actual_capsule_package_and_supported_plan(tmp_path):
    data={'summary':'Reusable measured-shot production rules','source_profile':{'likely_format':'reference_remake'},'segments':[],
      'execution_strategy':{'mode':'preset','reason':'Reviewed Motion dispatch'},'content_scope':{
      'schema_version':'capsule.content_scope.v1','series_fixed':['timing','quality'],'episode_variable':['topic','characters','locations'],'forbidden_reusable_literals':['PRIVATE_CHARACTER'],
      'policies':{'allow_series_fixed_defaults':True,'forbid_episode_specific_defaults':True,'active_recipe_examples_must_use_placeholders':True,'current_run_input_may_reuse_literal':True}},
      'capsule_recipe':{'structure_rules':['Preserve measured timing for {{topic}}.'],'visual_rules':['Use {{characters}} and {{locations}}.'],'audio_rules':['Quote separate approved audio.'],'quality_rules':['Check decoded duration, identity and action.']}}
    actual=reverse_runtime.capsule_call('recipe.create',{'name':'local-acceptance','recipe':data},tmp_path)
    assert actual['validation']['ok'];assert actual['upstream']=='capsule-cinema';assert actual['paid_requests']==0
    assert actual['scope_audit']['episode_literals_retained'] is False
    assert 'PRIVATE_CHARACTER' not in (Path(actual['path'])/'contracts/content_scope.yaml').read_text()
    assert '{{characters}}' in actual['resources']['recipes/visual.md']['content']
    changed=copy.deepcopy(data);changed['capsule_recipe']['visual_rules']=['Use approved {{characters}} with a consistent cool palette.']
    second=reverse_runtime.capsule_call('recipe.create',{'name':'local-acceptance','recipe':changed},tmp_path/'second-version')
    assert actual['resources']['recipes/visual.md']['sha256']!=second['resources']['recipes/visual.md']['sha256']
    plan=reverse_runtime.capsule_call('recipe.plan',{'path':actual['path'],'topic':'{{topic}}','params':{}},tmp_path)
    assert plan['production_plan']['digest'];assert plan['generation_dispatch']=='requires_motion_quote_and_approval'
    bad=copy.deepcopy(data);bad['summary']='PRIVATE_CHARACTER is not reusable'
    with pytest.raises(RuntimeError):reverse_runtime.capsule_call('recipe.create',{'name':'private-leak','recipe':bad},tmp_path)
