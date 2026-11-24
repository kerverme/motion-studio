import base64
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from test_text_video import FakeDB, fixture, Response, Store
from motion_worker import audio, config, pipeline, text_video as tv, video_inspection as vi, video_capabilities as caps
from motion_worker.storage import sha256_file


def approved_job():
    job = fixture()
    spec = job['package']['text_video']
    spec.update(version=2,input={'resolution':'480p','duration':60})
    shots = spec['plan']['shots'][:2]
    spec['plan']['shots'] = shots
    a = spec['approval']
    a['voice_model'] = job['package']['voice']['model_id'] = 'eleven_v4'
    a['inspection'] = {'model':'vision-fixture','max_input_tokens':24000,'max_output_tokens':2000,'estimated_usd_per_variant':.03}
    a['eleven'] = [{'slot':'eleven:shot_01','scene_id':'shot_01','model_id':'eleven_v4','voice_id':'test-voice','text':shots[0]['narration'],'credits':100},
                   {'slot':'sfx:shot_01','model_id':'eleven_text_to_sound_v3','text':'one bell','duration_seconds':.5,'credits':20}]
    a['fal'] = []
    for i, shot in enumerate(shots):
        for variant in range(1,3-i):
            payload = {'prompt':shot['visual_prompt'],'render_size':'480p','seconds':3}
            if i:
                payload['first_frame_url'] = tv.PREVIOUS_FRAME
                payload['include_audio'] = True
            a['fal'].append({'scene_id':shot['id'],'slot':'fal:'+shot['id']+(':2' if variant==2 else ''),
                    'endpoint_id':'fal-ai/fixture/'+('image' if i else 'text'),'schema_hash':'verified','payload':payload,
                    'category':'image-to-video' if i else 'text-to-video','resolution':'480p',
                    'previous_frame':bool(i),'native_audio':bool(i),'estimated_usd':.887,'edited_seconds':2+i,'generation_seconds':3})
    a['plan_hash'] = tv.canonical_hash({'input':spec['input'],'plan':spec['plan']})
    a['payload_hash'] = tv.canonical_hash({'fal':a['fal'],'eleven':a['eleven']})
    return job


class HistoryDB(FakeDB):
    def __init__(self,job):
        super().__init__(job)
        self.rows = {}
        self.report = None

    def one(self, sql, args=()):
        if sql.startswith('INSERT INTO video_model_benchmarks'):
            row = dict(zip('job_id approval_id slot scene_id endpoint_id model_name scene_type original_prompt compiled_prompt knowledge_version generation_params generation_seconds edited_seconds estimated_usd'.split(),args))
            return self.rows.setdefault(row['slot'],{**row,'id':row['slot']})
        return super().one(sql,args)

    def q(self, sql, args=()):
        if sql.startswith('UPDATE video_model_benchmarks SET quality='):
            self.rows[args[-1]]['quality'] = args[0].obj
        if sql.startswith('UPDATE jobs SET qa_report'):
            self.report = json.loads(args[0])
        return super().q(sql,args)


def review(passed=True):
    return {'scores':{k:90 if passed else 45 for k in vi.SCORES},'issues':[] if passed else ['wrong identity at 2.1s'],
            'recommendations':[] if passed else ['keep the original prop'],'revised_prompt':None if passed else 'Keep the paper boat red.',
            'needs_review':not passed}


class IntelligenceTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = patch.object(config,'WORKDIR',self.tmp.name+'/work')
        self.config.start()
        self.addCleanup(self.config.stop)
        self.job = approved_job()
        self.db = HistoryDB(self.job)
        self.ctx = pipeline.Ctx(self.db,Store(self.tmp.name+'/bucket'),self.job)
        self.spec = self.job['package']['text_video']

    def test_dynamic_approval_binds_endpoint_schema_audio_duration_quantity_and_cost(self):
        self.assertEqual(tv.validate(self.ctx)['version'],2)
        item = self.spec['approval']['fal'][0]
        for key, changed in [('endpoint_id','other'),('resolution','720p'),('payload',{'prompt':'other'}),
                             ('native_audio',True),('estimated_usd',.9),('schema_hash','changed')]:
            with patch.dict(item,{key:changed}),self.assertRaises(tv.ApprovalRequired):
                tv.validate(self.ctx)
        self.spec['approval']['fal'].pop()
        with self.assertRaises(tv.ApprovalRequired):
            tv.validate(self.ctx)
        # Canonical hash matches JavaScript JSON.stringify for small decimals and integral floats.
        self.assertEqual(tv.canonical_hash([1.0,.00001]),
                         hashlib.sha256(b'[1,0.00001]').hexdigest())

    def test_dispatch_rejection_prevents_paid_reservation(self):
        with patch.object(tv,'check_dispatch',side_effect=tv.ApprovalRequired('price changed')) as validate,patch.object(tv.requests,'post') as post:
            with self.assertRaisesRegex(tv.ApprovalRequired,'price changed'):
                tv.fal_shot(self.ctx,self.spec['plan']['shots'][0],0,None,self.spec['approval']['fal'][0])
            validate.assert_called_once()
            post.assert_not_called()
            self.assertFalse(self.db.calls)

    def test_stale_revision_and_unreported_cost(self):
        slot = 'fal:shot_01'
        with patch.object(config,'INTERNAL_TOKEN','internal-fixture'),patch.object(tv.requests,'post',return_value=Response({'ok':True,'approval_id':'stale','slot':slot})) as post:
            with self.assertRaises(tv.ApprovalRequired):tv.check_dispatch(self.ctx,slot)
            self.assertEqual(post.call_args.kwargs['json']['approval_id'],self.spec['approval']['id'])
        self.assertIsNone(tv.reported_cost_usd({'usage':{'estimated_cost':22}}))
        self.assertIsNone(tv.reported_cost_usd({'usage':{'cost':12,'currency':'THB'}}))
        self.assertEqual(tv.reported_cost_usd({'usage':{'cost':0.6}}),0.6)

    def test_semantic_quality_only_scores_visible_evidence(self):
        value = review()
        value['scores']['character_consistency'] = None
        response = {'output':[{'content':[{'type':'output_text','text':json.dumps(value)}]}]}
        quality = vi.result_quality(response,[{'seconds':1}],'vision-fixture')
        self.assertEqual(quality['method'],'sampled_frames')
        self.assertEqual(quality['audio_sync'],'not_assessed')
        value['scores']['scene_logic'] = 111
        response['output'][0]['content'][0]['text'] = json.dumps(value)
        with self.assertRaises(ValueError):vi.result_quality(response,[],'vision-fixture')

    def test_capability_falls_back_to_priced_voice_and_verifies_sfx_enum_and_credit_unit(self):
        def get(url,**kwargs):
            if url.endswith('/v1/models'):
                return Response([{'model_id':'eleven_v3'},{'model_id':'eleven_v4'}])
            response = Response({})
            response.content = b'fixture'
            docs = {caps.SFX_SCHEMA:'Allowed values: eleven_text_to_sound_v2, eleven_text_to_sound_v3',
                    caps.SFX_SOURCE:'Cost: 40 credits per second when duration is specified',
                    caps.PRICE_SOURCE:'<b>v4</b><p>Text to Speech</p><i>New</i><p>$0.09</p><b>Price per 1K characters</b>'
                                      '<b>v3</b><p>Text to Speech</p><p>$0.08</p><b>Price per 1K characters</b>'
                                      '<p>Sound Effects</p><p>Audio Generation</p><p>$0.12</p><b>Price per minute</b>'}
            response.text = docs[url]
            return response
        with patch.object(config,'ELEVENLABS_API_KEY','fixture'),patch.object(caps.requests,'get',side_effect=get):
            offer=caps.probe()
            self.assertEqual(offer['voice_model'],'eleven_v4')
            self.assertEqual(offer['voice_usd_per_1000_characters'],.09)
            self.assertEqual(offer['sfx_models'][0],'eleven_text_to_sound_v3')
            self.assertEqual(offer['sfx_credits_per_second'],40)
            self.assertEqual(offer['sfx_usd_per_second'],.12/60)
            with patch.object(caps,'official_text',return_value='<div>v4 Turbo $0.04</div>'):
                self.assertIsNone(caps.audio_offer()['voice_model'])

    def make_fixture(self):
        path = self.tmp.name+'/vendor.mp4'
        tv.ffmpeg(['-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration=3','-f','lavfi','-i','sine=frequency=220:duration=3',
                   '-c:v','libx264','-threads','1','-preset','ultrafast','-c:a','aac','-t','3',path])
        return path

    def test_edit_reference_is_verified_then_trimmed_before_dispatch(self):
        source = self.make_fixture()
        url = 'https://v3.fal.media/video.mp4'
        item = {'source_clip':{'field':'video_url','seconds':1,'url':url,'sha256':sha256_file(source)},'payload':{'video_url':url},'generation_seconds':1}
        with patch.object(tv,'download_video',side_effect=lambda url,path,**kwargs:shutil.copyfile(source,path)):
            signed = tv.prepare_source_clip(self.ctx,item)
            self.assertTrue(signed.endswith('_1s.mp4'))
            clip = self.ctx.path('fal','source_'+sha256_file(source)+'_1s.mp4')
            self.assertAlmostEqual(audio.duration(clip),1,places=2)
            item['source_clip']['sha256'] = 'a'*64
            with self.assertRaisesRegex(tv.ApprovalRequired,'เปลี่ยน'):tv.prepare_source_clip(self.ctx,item)

    def test_real_media_variants_native_audio_cost_inspection_and_resume(self):
        source = self.make_fixture()
        tone = self.tmp.name+'/voice.mp3'
        tv.ffmpeg(['-f','lavfi','-i','sine=frequency=600:duration=0.5','-c:a','libmp3lame',tone])
        encoded = base64.b64encode(Path(tone).read_bytes()).decode()
        posts, checked, fal_payloads = [], [], []
        def post(url,headers,json,**kwargs):
            if url.endswith('/input_tokens'):
                return Response({'input_tokens':1000})
            posts.append(url)
            if 'text-to-dialogue' in url:
                text = json['inputs'][0]['text']
                return Response({'audio_base64':encoded,'voice_segments':[{'voice_id':'test-voice','dialogue_input_index':0,'start_time_seconds':0,'end_time_seconds':.45,'character_start_index':0,'character_end_index':len(text)}],'alignment':{'characters':list(text),'character_start_times_seconds':[i*.45/len(text) for i in range(len(text))],'character_end_times_seconds':[(i+1)*.45/len(text) for i in range(len(text))]}},headers={'character-cost':'5'})
            if 'sound-generation' in url:
                response = Response({},headers={'character-cost':'20'})
                response.content = Path(tone).read_bytes()
                return response
            if url.endswith('/v1/responses'):
                content = json['input'][0]['content']
                images = [x['image_url'] for x in content if x['type']=='input_image']
                self.assertEqual(len(images),5)
                self.assertTrue(all(base64.b64decode(x.split(',')[1]).startswith(b'\xff\xd8') for x in images))
                self.assertGreater(len(set(images)),1)
                quality=review(len(fal_payloads)!=2)
                return Response({'id':'resp_test'+str(len(fal_payloads)),'status':'completed','usage':{'input_tokens':84},
                                 'output':[{'content':[{'type':'output_text','text':__import__('json').dumps(quality)}]}]})
            fal_payloads.append(json)
            root=f'https://queue.fal.run/fixture/requests/r{len(fal_payloads)}'
            return Response({'request_id':f'r{len(fal_payloads)}','status_url':root+'/status','response_url':root})
        def get(url,**kwargs):
            return Response({'status':'COMPLETED'} if url.endswith('/status') else {'video':{'url':'https://v3.fal.media/movie.mp4'}})
        with patch.dict(os.environ,{'FAL_KEY':'fixture','OPENAI_API_KEY':'fixture'}),patch.object(tv,'check_dispatch',side_effect=lambda ctx,slot:checked.append(slot)),patch.object(tv.requests,'post',side_effect=post),patch.object(tv.requests,'get',side_effect=get),patch.object(tv,'download_video',side_effect=lambda url,path:shutil.copyfile(source,path)),patch.object(pipeline,'stage_upload',return_value={'episode_number':1}):
            tv.run(self.ctx)
            self.assertEqual(len(fal_payloads),3)
            self.assertTrue(fal_payloads[-1]['first_frame_url'].endswith('shot_01_end.png'))
            self.assertNotIn('enable_safety_checker',fal_payloads[-1])
            self.assertEqual(len(checked),8)
            self.assertEqual(sum('text-to-dialogue' in u for u in posts),1)
            self.assertEqual(sum('sound-generation' in u for u in posts),1)
            self.assertEqual(sum('/v1/responses' in u for u in posts),3)
            self.assertEqual(self.db.rows['fal:shot_01:2']['quality']['status'],'needs_review')
            self.assertTrue(self.db.report['requires_owner_review'])
            final = self.ctx.path('final.mp4')
            self.assertAlmostEqual(audio.duration(final),5,places=1)
            timeline = json.loads(Path(self.ctx.path('timeline.json')).read_text())['timeline']
            self.assertEqual(timeline[-1]['timing'],'editorial_scene')
            self.assertFalse(timeline[-1]['phrases'][0]['words'])
            self.assertGreater(audio.window_db(audio.decode(final),3,4),-45)
            self.assertEqual(self.job['status'],'READY_TO_POST')
            self.assertEqual(len({r['video_key'] for r in self.job['stage_results']['FAL_SHOTS']['shots']}),3)
            tv.run(self.ctx)
            self.assertEqual(len(posts),8)
            self.assertEqual(len(checked),8)
