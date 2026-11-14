"""Real media cuts and explicit provider fixtures; never paid inference."""
import copy,json,sys,wave,subprocess,threading,contextlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import numpy as np
import pytest,requests
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from motion_worker import reverse_prompts as p,reverse_prompt_audio as a,reverse_media as media
from motion_worker.creative_ledger import Ledger,AmbiguousCall
from test_reverse_prompts import document


def context(tmp_path):
    def path(*parts):
        v=tmp_path.joinpath(*parts);v.parent.mkdir(parents=True,exist_ok=True);return str(v)
    return SimpleNamespace(path=path,job={'id':'job','stage_results':{}},db=SimpleNamespace(one=Mock(),q=Mock()))


def spoken():
    return {'status':'transcribed','text':'อย่าขยับ! "Stay here."','languages':['th','en'],'source_start_s':3,'source_end_s':5,'duration_s':2,'timing':'selected_range_only','speaker':'unknown','review':'asr_needs_owner_review'}


def test_audio_window_uses_video_origin_and_preserves_delayed_sound(tmp_path):
    source=tmp_path/'offset.mkv'
    p.ffmpeg(['-f','lavfi','-i','testsrc2=s=128x96:r=24:d=3','-itsoffset','0.5','-f','lavfi','-i','sine=frequency=660:sample_rate=16000:duration=2','-c:v','libx264','-c:a','pcm_s16le','-output_ts_offset','10',source])
    timing=media.frame_timing(source);assert timing['video_start_s']==10
    e,indices=p.selection_frames(timing,[{'id':'shot_001','start_frame':0,'end_frame_exclusive':72}],.125,2.125)
    wav=tmp_path/'selected.wav';assert a.cut_audio(source,timing,e,wav)==2
    with wave.open(str(wav)) as f: samples=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2')
    assert len(samples)==32000
    assert np.max(np.abs(samples[:5500]))==0 # the first 0.375s stays silent
    assert np.max(np.abs(samples[6400:]))>1000


def test_add_audio_to_existing_evidence_does_not_reextract_or_change_frames(tmp_path):
    source=tmp_path/'source.mp4';p.ffmpeg(['-f','lavfi','-i','testsrc2=s=128x96:r=24:d=3','-f','lavfi','-i','sine=frequency=550:duration=3','-c:v','libx264','-c:a','aac','-shortest',source])
    ctx=context(tmp_path);preview=Path(ctx.path('prompt-preview.mp4'));p.ffmpeg(['-i',source,'-t','2','-an','-c:v','copy',preview])
    evidence={'start_s':0,'end_s':2,'duration_s':2,'preview_asset_id':'old-clip','frames':[{'asset_id':'old-image'}]}
    row={'id':'sel','evidence':copy.deepcopy(evidence),'audio':None};saved=[]
    def save(ctx,pid,path,role,**kw):
        saved.append((role,Path(path)));return {'id':role,'sha256':media.file_sha(path)}
    with patch.object(a,'save_private',side_effect=save),patch.object(a,'check_active'):
        out=a.prepare_audio(ctx,{'id':'project','source_sha256':'f'*64},row,source,media.frame_timing(source),evidence)
    assert row['evidence']==evidence
    assert [x[0] for x in saved]==['prompt_audio','prompt_clip_audio']
    assert any(x['codec_type']=='audio' for x in media.probe(saved[-1][1])['streams'])
    assert out['duration_s']==2 and out['status']=='available'
    assert all('SET evidence=' not in call.args[0] for call in ctx.db.q.call_args_list)


def test_dialogue_is_verbatim_and_js_python_compilers_and_locks_agree():
    doc=p.validate_document(document(),{'duration_s':2,'shots':[{'id':'shot_001','start_s':0,'end_s':2}]});doc['audio']=spoken()
    text=p.prompt_text(doc);b=p.prompt_text(doc,{'characters':{'C1':'young adult man wearing a navy jacket'},'locations':{'L1':'night alley'}})
    assert text.split('LOCKED SHOT DIRECTIONS')[1]==b.split('LOCKED SHOT DIRECTIONS')[1]
    assert 'อย่าขยับ!' in b and 'No added captions, logos or dialogue.' not in text
    api=Path(__file__).resolve().parents[2]/'api'
    script="import {motionLock,promptText} from './src/reverse-prompts.ts';let s='';for await(const c of process.stdin)s+=c;const d=JSON.parse(s);process.stdout.write(JSON.stringify({hash:motionLock(d),text:promptText(d)}));"
    result=json.loads(subprocess.check_output(['node','--import','tsx','--input-type=module','-e',script],cwd=api,input=json.dumps(doc).encode()))
    assert result=={'hash':p.motion_lock(doc),'text':text}
    assert a.dialogue_document({'text':'สวัสดี','languages':[{'code':'th'}]},spoken())['text']=='สวัสดี'
    empty=a.dialogue_document({'text':'','languages':[]},spoken());assert empty['status']=='no_speech_detected' and empty['speaker']=='unknown'


def test_synchronous_asr_lost_result_is_never_reposted(tmp_path,monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY','test-key');ctx=context(tmp_path);path=tmp_path/'audio.wav';path.write_bytes(b'fixture')
    audio={'asset_id':'asset','sha256':media.file_sha(path),'duration_s':2};ctx.db.one.side_effect=lambda sql,args: {'sha256':audio['sha256']} if 'reverse_assets' in sql else None
    rate={'model':'gpt-transcribe','per_minute':.0045};task={'slot':'asr:sel','model':'gpt-transcribe','payload':{'audio':audio},'rate':rate,'usd':.001}
    quote={'binding':'bound','id':'quote','key_fingerprints':{'openai':a.fingerprint('OPENAI_API_KEY')},'valid_until':'2099-01-01T00:00:00Z'}
    get=Mock(status_code=200);get.json.return_value={'id':'gpt-transcribe'}
    with patch.object(a,'transcription_rate',return_value=rate),patch.object(a,'fetch_private',return_value=path),patch.object(a,'check_active'),patch.object(requests,'get',return_value=get),patch.object(requests,'post',side_effect=requests.ReadTimeout('lost')) as post,patch.object(Ledger,'reserve',side_effect=[{'id':'call','status':'started'},AmbiguousCall('unknown')]):
        with pytest.raises(requests.ReadTimeout):a._transcription_call(ctx,{'id':'project'},task,quote)
        with pytest.raises(AmbiguousCall):a._transcription_call(ctx,{'id':'project'},task,quote)
        assert post.call_count==1
        assert post.call_args.kwargs['data']=={'model':'gpt-transcribe','response_format':'json'}
    assert any('uncertain' in c.args[0] for c in ctx.db.q.call_args_list)


def test_speech_cache_reuses_same_audio_across_parent_versions_and_blocks_unknown_claims(tmp_path):
    ctx=context(tmp_path);cache={};ctx.db.lock=threading.RLock()
    class Connection:
        transaction=staticmethod(contextlib.nullcontext)
        def execute(self,sql,args):
            key=args[0]
            if sql.startswith('SELECT'):return SimpleNamespace(fetchone=lambda:cache.get(key))
            cache[key]={'result':args[2].obj};return SimpleNamespace(fetchone=lambda:{'cache_key':key})
    ctx.db.conn=Connection()
    def q(sql,args):
        if sql.startswith('UPDATE creative_cache'):cache[args[1]]={'result':args[0].obj}
    ctx.db.q.side_effect=q
    project={'id':'p','source_sha256':'s'};quote={'key_fingerprints':{'openai':'k'}}
    task={'role':'prompt_transcribe','payload':{'model':'gpt-transcribe','audio':{'sha256':'a'},'version_id':None}}
    call=Mock(return_value={'response':{'text':'hello'}})
    first=p.response_call(ctx,project,task,quote,invoke=call)
    task['payload']['version_id']='existing-A'
    assert p.response_call(ctx,project,task,quote,invoke=call)==first and call.call_count==1
    for row in cache.values():row['result']={'owner':'old-uncertain-job'}
    with pytest.raises(AmbiguousCall):p.response_call(ctx,project,task,quote,invoke=call)
    assert call.call_count==1


def test_speech_adds_immutable_child_and_preserves_existing_B(tmp_path):
    ctx=context(tmp_path);doc=p.validate_document(document(),{'duration_s':2,'shots':[{'id':'shot_001','start_s':0,'end_s':2}]})
    old={'id':'original','selection_id':'sel','document':doc,'replacements':{'characters':{'C1':'blue robot'},'locations':{}},'locks_hash':p.motion_lock(doc),'provenance':{}}
    audio={'status':'available','sha256':'f'*64,**{k:spoken()[k] for k in ('source_start_s','source_end_s','duration_s')}};sel={'id':'sel','audio':audio}
    ctx.db.one.side_effect=lambda sql,args: sel if 'reverse_prompt_selections' in sql else old if 'SELECT * FROM reverse_prompt_versions' in sql else None
    task={'selection_id':'sel','model':'gpt-transcribe','payload':{'audio':audio,'version_id':'original'}}
    paid={'response':{'text':'อย่าขยับ!','languages':[{'code':'th'}]},'response_asset_id':'raw'}
    with patch.object(p,'response_call',return_value=paid):a.transcribe(ctx,{'id':'project'},task,{'id':'q'})
    saved=next(c.args[1] for c in ctx.db.q.call_args_list if c.args[0].startswith('INSERT INTO reverse_prompt_versions'))
    assert saved[3]=='original';assert 'audio' not in doc
    assert saved[4].obj['shots']==doc['shots'];assert saved[4].obj['audio']['text']=='อย่าขยับ!'
    assert 'blue robot' in saved[7] and 'อย่าขยับ!' in saved[6] and 'อย่าขยับ!' in saved[7]


def test_character_changes_only_selected_main_slot_clothes_and_explicit_location(tmp_path):
    ctx=context(tmp_path);doc=p.validate_document(document(),{'duration_s':2,'shots':[{'id':'shot_001','start_s':0,'end_s':2}]});doc['characters'].append({'id':'C2','description':'supporting green robot'});doc['audio']=spoken()
    old={'id':'old','selection_id':'sel','document':doc,'locks_hash':p.motion_lock(doc),'prompt_a':p.prompt_text(doc),'provenance':{}}
    ctx.db.one.side_effect=lambda sql,args: old if 'SELECT * FROM reverse_prompt_versions' in sql else None
    replacements={'characters':{},'locations':{'L1':'rainy alley'}}
    task={'selection_id':'sel','model':'gpt-6.1-sol','payload':{'version_id':'old','context':{'character_id':'C1','brief':'young man','document':doc,'replacements':replacements}}}
    design={'appearance':'Adult young man, age 25, short black hair.','clothing':'Navy weatherproof jacket, dark trousers and nonslip boots.','reason_th':'ชุดกันฝนและรองเท้าที่เคลื่อนไหวได้สะดวก'}
    paid={'response':{'status':'completed','output':[{'content':[{'type':'output_text','text':json.dumps(design)}]}]},'response_asset_id':'raw'}
    with patch.object(p,'response_call',return_value=paid):out=p.character(ctx,{'id':'project'},task,{'id':'quote'})
    saved=next(c.args[1] for c in ctx.db.q.call_args_list if c.args[0].startswith('INSERT INTO reverse_prompt_versions'))
    assert saved[4].obj==doc and saved[6]==old['prompt_a'] and saved[8]==old['locks_hash']
    r=saved[5].obj;assert r['characters']=={'C1':design['appearance']+' Clothing: '+design['clothing']}
    assert r['locations']==replacements['locations'] and '[C2]: supporting green robot' in saved[7]
    assert saved[7].split('LOCKED SHOT DIRECTIONS')[1]==old['prompt_a'].split('LOCKED SHOT DIRECTIONS')[1]
    assert replacements['characters']=={} and out['character_id']=='C1'
