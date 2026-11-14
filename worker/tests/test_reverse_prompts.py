import copy,json,sys,subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import pytest,requests
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from motion_worker import reverse_prompts as p,reverse_media as media
from motion_worker.creative_ledger import Ledger

def document():return {'summary_th':'Synthetic fixture','characters':[{'id':'C1','description':'red robot'}],'locations':[{'id':'L1','description':'green room'}],'shots':[{'id':'shot_001','start_s':0,'end_s':2,'location_id':'L1','opening':'[C1] at left in [L1].','actions':[{'t0':0,'t1':2,'text':'[C1] raises its right arm.'}],'ending':'[C1] holds its right arm up.','camera':'Locked camera.','lighting':'Soft side light.','style':'3D animation.','props':'None.'}],'compatibility':['Right arm required.'],'uncertainty':['Fixture only.']}

def test_prompt_validation_locks_timing_slots_and_roundtrips_js_hash():
    evidence={'duration_s':2,'shots':[{'id':'shot_001','start_s':0,'end_s':2}]};doc=p.validate_document(document(),evidence)
    disclosed=document();disclosed['uncertainty']=['100% matching is not guaranteed.']
    assert p.validate_document(disclosed,evidence)['uncertainty'][0]==disclosed['uncertainty'][0]
    a=p.prompt_text(doc);b=p.prompt_text(doc,{'characters':{'C1':'white rabbit'},'locations':{'L1':'snowy cabin'}})
    assert a.split('LOCKED SHOT DIRECTIONS')[1]==b.split('LOCKED SHOT DIRECTIONS')[1]
    api=Path(__file__).resolve().parents[2]/'api'
    script="import {motionLock,promptText} from './src/reverse-prompts.ts';let s='';for await(const c of process.stdin)s+=c;const d=JSON.parse(s);process.stdout.write(JSON.stringify({hash:motionLock(d),text:promptText(d)}));"
    result=json.loads(subprocess.check_output(['node','--import','tsx','--input-type=module','-e',script],cwd=api,input=json.dumps(doc).encode()))
    assert result=={'hash':p.motion_lock(doc),'text':a}
    for mutate in [lambda d:d['shots'][0].update(end_s=3),lambda d:d['shots'][0]['actions'][0].update(t1=3),lambda d:d['shots'][0].update(opening='[C9] waves'),lambda d:d['characters'][0].update(description='robot\nnew action')]:
        bad=document();mutate(bad)
        with pytest.raises(ValueError):p.validate_document(bad,evidence)

def test_real_frame_selection_and_preparation_preserves_absolute_pts(tmp_path):
    source=tmp_path/'source.mp4';p.ffmpeg(['-f','lavfi','-i','testsrc2=s=180x320:r=24:d=3','-c:v','libx264','-pix_fmt','yuv420p',source])
    timing=media.frame_timing(source);shots=[{'id':'shot_001','start_frame':0,'end_frame_exclusive':24},{'id':'shot_002','start_frame':24,'end_frame_exclusive':72}]
    evidence,indices=p.selection_frames(timing,shots,.12,2.12);assert evidence['start_frame']==3;assert evidence['end_frame_exclusive']==51;assert {3,23,24,50}.issubset(indices)
    assert evidence['shots'][0]['end_s']==evidence['shots'][1]['start_s'];assert evidence['duration_s']==2
    calls=[]
    def save(ctx,pid,path,role,**kw):
        assert Path(path).is_file();calls.append((role,kw));return {'id':str(len(calls)),'sha256':media.file_sha(path)}
    class DB:
        def one(self,sql,args):return {'id':'selection','evidence':None} if 'reverse_prompt_selections' in sql else {'id':'source'}
        q=Mock()
    def path(*parts):
        v=tmp_path.joinpath('job',*parts);v.parent.mkdir(parents=True,exist_ok=True);return str(v)
    ctx=SimpleNamespace(db=DB(),path=path)
    with patch.object(p,'fetch_private',return_value=source),patch.object(p,'save_private',side_effect=save),patch.object(p,'check_active'):
        result=p.prepare(ctx,{'id':'project','source_asset_id':'source','source_sha256':'a'*64,'analysis':{'shots':shots}},{'selection_id':'selection','range':{'start_s':.12,'end_s':2.12}})
    assert result['frames']==len(indices);assert result['paid_requests']==0;assert calls[-1][0]=='prompt_clip'
    prepared=ctx.db.q.call_args.args[1][0].obj;assert [f['frame'] for f in prepared['frames']]==indices;assert prepared['frames'][0]['source_s']==.125


def test_openai_submission_is_one_post_and_accepted_id_resume_is_get_only(tmp_path,monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY','fixture-key')
    rate={'input_per_million':2,'output_per_million':10};task={'slot':'prompt','model':'gpt-6.1-sol','usd':1,'rate':rate,'payload':{'evidence':{'frames':[]},'max_output_tokens':16000,'reasoning':'high','system':'test'}}
    quote={'id':'quote','binding':'binding','key_fingerprints':{'openai':p.fingerprint('OPENAI_API_KEY')},'valid_until':'2099-01-01T00:00:00+00:00'}
    row={'id':'call','provider_id':None,'status':'started'};ctx=SimpleNamespace(db=SimpleNamespace(one=Mock(return_value=None),q=Mock()),job={'id':'job'},path=lambda *parts:str(tmp_path.joinpath(*parts)))
    class Response:
        status_code=200;ok=True
        def __init__(self,data):self.data=data
        def json(self):return self.data
        def raise_for_status(self):pass
    with patch.object(p,'rate_config',return_value=rate),patch.object(p,'check_active'),patch.object(Ledger,'reserve',return_value=row),patch.object(requests,'get',return_value=Response({'id':'gpt-6.1-sol'})),patch.object(requests,'post',side_effect=requests.ReadTimeout('lost')) as post:
        with pytest.raises(requests.ReadTimeout):p._response_call(ctx,{'id':'project'},task,quote)
        assert post.call_count==1;assert any('uncertain' in c.args[0] for c in ctx.db.q.call_args_list)
    saved={**row,'provider_id':'resp_saved'};ctx.db.one.return_value=saved;(tmp_path/'prompt-response').mkdir()
    with patch.object(p,'check_active'),patch.object(Ledger,'reserve',return_value=saved),patch.object(p,'save_private',return_value={'id':'response-asset'}),patch.object(requests,'post') as post,patch.object(requests,'get',return_value=Response({'status':'completed','output':[],'usage':{'input_tokens':100,'output_tokens':10}})) as get:
        result=p._response_call(ctx,{'id':'project'},task,quote);assert not post.called;assert get.call_count==1;assert result['response_asset_id']=='response-asset'
