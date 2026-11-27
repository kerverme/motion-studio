"""Run one real UGC queue claim using only a fake fal/ElevenLabs transport."""
import base64
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from motion_worker.db import DB
from motion_worker.storage import LocalStorage
from motion_worker import main, r2, text_video, video_capabilities


def main_fixture():
    db = DB()
    assert db.one('SELECT current_database() AS db')['db'] == 'ugc_test'
    root = Path(os.environ['UGC_TEST_ASSETS'])
    sent = []
    tone = subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i',
        'sine=frequency=260:duration=1.2','-f','mp3','-'])
    raw = root/'mock-raw.mp4'
    if not raw.exists():
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i',
            'testsrc2=size=360x640:rate=30','-t','12','-threads','2','-c:v','libx264',str(raw)],check=True)
    class FakeStore(LocalStorage):
        def signed_url(self,key,expires):
            assert self.exists(key)
            return 'https://r2-fixture.invalid/'+key
    def response(body, headers=None):
        return SimpleNamespace(ok=True,status_code=200,headers=headers or {},json=lambda:body,raise_for_status=lambda:None)
    def post(url, headers, json, **kwargs):
        if url=='http://ugc-fixture/internal/ugc/check-dispatch':
            from urllib.request import Request,urlopen
            from urllib.parse import urlsplit
            body = __import__('json').dumps(json).encode()
            request=Request(os.environ['UGC_TEST_API']+urlsplit(url).path,data=body,
                headers={**headers,'Content-Type':'application/json'}, method='POST')
            with urlopen(request,timeout=20) as r:
                return response(__import__('json').load(r))
        if url.startswith('https://queue.fal.run/'):
            sent.append('fal')
            assert json['image_url'].startswith('https://r2-fixture.invalid/ugc-frames/')
            assert not json['generate_audio']
            href='https://queue.fal.run/mock/requests/req_ugc'
            return response({'request_id':'req_ugc','response_url':href,'status_url':href+'/status'})
        if '/text-to-speech/' not in url:
            raise AssertionError('Unexpected HTTP request')
        sent.append('eleven')
        chars=list(json['text'])
        start=[i/len(chars) for i in range(len(chars))]
        end=[(i+1)/len(chars) for i in range(len(chars))]
        return response({'audio_base64':base64.b64encode(tone).decode(), 'alignment':{
            'characters':chars,'character_start_times_seconds':start,'character_end_times_seconds':end}},
            {'request-id':'voice_fixture','character-cost':str(len(chars))})
    def get(url, **kwargs):
        assert url.startswith('https://queue.fal.run/mock/requests/')
        return response({'status':'COMPLETED'} if url.endswith('/status') else
                        {'video':{'url':'https://v3.fal.media/mock.mp4'},'billing':{'total_cost':.98,'currency':'USD'}})
    def download(url, output):
        assert url=='https://v3.fal.media/mock.mp4'
        shutil.copyfile(raw,output)

    job = db.claim('ugc-fixture')
    assert str(job['id']) == sys.argv[1]
    voice_offer = {'voice_model':'eleven_v3','voice_usd_per_1000_characters':.1}
    with patch.object(text_video.requests,'post',side_effect=post), patch.object(text_video.requests,'get',side_effect=get), \
         patch.object(r2,'ugc_references',return_value=FakeStore(str(root/'r2'))), \
         patch.object(text_video,'download_video',side_effect=download), patch.object(video_capabilities,'audio_offer',return_value=voice_offer):
        result = main.handle(db,FakeStore(str(root)),job)
    print(json.dumps({'calls':sent,'result':result}))


if __name__=='__main__':
    main_fixture()
