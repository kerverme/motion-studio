"""Approved Fal queue adapter. One POST; accepted IDs resume by GET only."""
import base64
import datetime as dt
import hashlib
import json
import os
import time
from pathlib import Path
import requests
from psycopg.types.json import Jsonb
from .creative_ledger import Ledger,AmbiguousCall,digest
from .text_video import ApprovalRequired,check_active,queue_url,download_video
from .reverse_media import fetch_private,file_sha,save_private


def fingerprint(name):
    value=os.environ.get(name,'')
    return hashlib.sha256(value.encode()).hexdigest()[:24] if value else None


def headers():
    key=os.environ.get('FAL_KEY')
    if not key:raise ApprovalRequired('Motion worker FAL_KEY is unavailable')
    return {'Authorization':'Key '+key,'Content-Type':'application/json','X-Fal-No-Retry':'1',
            'X-Fal-Store-IO':'0','x-app-fal-disable-fallback':'true'}


def verify_price(task):
    if task.get('pricing_valid_until') and dt.datetime.now(dt.timezone.utc)>=dt.datetime.fromisoformat(task['pricing_valid_until']):raise ApprovalRequired('Maintained model configuration price expired; refresh before dispatch')
    r=requests.get('https://api.fal.ai/v1/models/pricing',params={'endpoint_id':task['endpoint']},headers=headers(),timeout=25)
    r.raise_for_status()
    live=next((x for x in r.json().get('prices',[]) if x['endpoint_id']==task['endpoint']),None)
    if not live or any(live.get(k)!=task['rate'].get(k) for k in ('unit','unit_price','currency')):
        raise ApprovalRequired('Fal pricing changed; inspect and approve a new quote')
    if task.get('token_rate'):
        r=requests.get('https://openrouter.ai/api/v1/models',timeout=25);r.raise_for_status()
        model=next((x for x in r.json().get('data',[]) if x['id']==task['model']),None)
        old=task['token_rate'];price=(model or {}).get('pricing',{})
        if not model or price!=old.get('published_pricing'):
            raise ApprovalRequired('Token pricing changed; inspect a new quote')


def asset_uri(ctx,project_id,asset_id):
    asset=ctx.db.one('SELECT * FROM reverse_assets WHERE id=%s AND project_id=%s',(asset_id,project_id))
    if not asset:raise ApprovalRequired('Approved input asset is unavailable')
    path=fetch_private(ctx,asset,ctx.path('inputs',str(asset['id'])))
    if asset['bytes']>8*1024*1024:raise ApprovalRequired('Provider input exceeds the bounded data-URI adapter')
    if asset['content_type'].startswith('image/'):
        from PIL import Image
        with Image.open(path) as image:
            if image.width*image.height>40000000:raise ApprovalRequired('Reference image exceeds the decoded pixel limit')
            image.verify()
    return 'data:'+asset['content_type']+';base64,'+base64.b64encode(Path(path).read_bytes()).decode()


def _queue_result(ctx,row):
    # Construct the endpoint request URL from the saved identity. Never follow
    # provider-supplied arbitrary URLs or issue another POST.
    state=row.get('usage') or {}
    # Fal returns canonical queue URLs which are persisted immediately on accept.
    if not state.get('status_url') or not state.get('response_url'):
        raise AmbiguousCall('Accepted request needs its saved Fal queue URLs; no POST retry')
    deadline=time.monotonic()+2700
    while time.monotonic()<deadline:
        check_active(ctx)
        r=requests.get(queue_url(state['status_url']),headers=headers(),timeout=30);r.raise_for_status();status=r.json()
        if status.get('status')=='COMPLETED':
            response=requests.get(queue_url(state['response_url']),headers=headers(),timeout=90)
            if not response.ok:raise ApprovalRequired('Provider request completed with an error; no paid retry')
            return response.json()
        if status.get('status') in ('FAILED','CANCELLED'):raise ApprovalRequired('Provider rejected the accepted request; inspect before any new paid attempt')
        time.sleep(5)
    raise RuntimeError('Provider request still processing; its saved ID will be polled on resume')


def _fal_call(ctx,project,task,quote):
    check_active(ctx)
    if quote['key_fingerprints']['fal']!=fingerprint('FAL_KEY'):raise ApprovalRequired('Fal key changed since approval')
    logical=logical_input(project,task)
    key='reverse:'+quote['binding']+':'+task['slot']
    ledger=Ledger(ctx)
    old=ctx.db.one('SELECT * FROM creative_calls WHERE job_id=%s AND call_key=%s',(ctx.job['id'],key))
    if not old:
        if dt.datetime.now(dt.timezone.utc)>dt.datetime.fromisoformat(quote['valid_until']):raise ApprovalRequired('Approval expired; quote again before new spending')
        verify_price(task)
    row=ledger.reserve(key,'fal',task['endpoint'],task['category'],logical,task['usd'])
    if row['status'] in ('complete','reconciled'):
        if row.get('actual_usd') is not None and float(row['actual_usd'])>task['usd']:raise ApprovalRequired('Prior actual cost exceeded estimate; inspect before continuing')
        return row['result']
    try:
        if not row.get('provider_id'):
            current=ctx.db.one('SELECT current_revision FROM reverse_projects WHERE id=%s',(project['id'],))
            if task['role'] not in ('vision','image') and (current['current_revision'] or 'none')!=quote['revision']:raise ApprovalRequired('Plan edited after approval; no new paid dispatch')
            payload=dict(task['payload'])
            if task.get('model_schema'):
                import jsonschema
                jsonschema.Draft202012Validator(task['model_schema']).validate(payload)
            if task['role'] in ('vision','visual_qa'):
                payload['video_urls']=[asset_uri(ctx,project['id'],task['clip']['asset_id'])]
            if task['role']=='video':
                for ref in task.get('references',[]):
                    payload['end_image_url' if ref['role']=='last_frame' else 'image_url']=asset_uri(ctx,project['id'],ref['asset_id'])
                if task.get('handoff_asset_id'):payload['image_url']=asset_uri(ctx,project['id'],task['handoff_asset_id'])
            check_active(ctx)
            # requests has no retry adapter. Uncertain timeout remains reserved.
            response=requests.post('https://queue.fal.run/'+task['endpoint'],headers=headers(),json=payload,timeout=60,allow_redirects=False)
            if not response.ok:raise ApprovalRequired('Fal submission HTTP '+str(response.status_code)+'; inspect ledger before any new approval')
            accepted=response.json();ident=accepted.get('request_id')
            if not ident:raise AmbiguousCall('Fal response has no request ID; no resubmission')
            state={'endpoint':task['endpoint'],'status_url':queue_url(accepted.get('status_url')),'response_url':queue_url(accepted.get('response_url'))}
            ctx.db.q('UPDATE creative_calls SET provider_id=%s,usage=%s,updated_at=now() WHERE id=%s',(ident,Jsonb(state),row['id']))
            row.update(provider_id=ident,usage=state)
        result=_queue_result(ctx,row)
        raw=Path(ctx.path('provider',str(row['id'])+'.json'));raw.write_text(json.dumps(result,ensure_ascii=False))
        evidence=save_private(ctx,project['id'],raw,'provider_response',shot_id=task.get('shot_id'),content_type='application/json',metadata={'call_id':str(row['id']),'quote_id':quote['id']})
        # Persist the paid response before schema/visual validation: a malformed
        # paid result must never cause a second charge on resume.
        usage=result.get('usage') or {};actual=usage.get('cost')
        if actual is not None:
            actual=float(actual)
            if not 0<=actual<1000:raise ValueError('Provider cost is invalid')
        value={'response_asset_id':str(evidence['id']),'provider_id':row['provider_id'],'usage':usage,'response':result}
        ctx.db.q("UPDATE creative_calls SET status='complete',result=%s,usage=%s,actual_usd=%s,updated_at=now() WHERE id=%s",(Jsonb(value),Jsonb({**row['usage'],**usage}),actual,row['id']))
        if actual is not None and actual>task['usd']:raise ApprovalRequired('Actual provider cost exceeded estimate; further paid dispatch blocked')
        return value
    except Exception as error:
        ctx.db.q("UPDATE creative_calls SET status='uncertain',error=%s,updated_at=now() WHERE id=%s AND status='started'",(type(error).__name__,row['id']))
        raise


def logical_input(project,task):
    return {'project_id':str(project['id']),'source_sha256':project['source_sha256'],'endpoint':task['endpoint'],
        'payload':task['payload'],'clip':task.get('clip'),'references':task.get('references',[]),'handoff_asset_id':task.get('handoff_asset_id')}


def fal_call(ctx,project,task,quote):
    key='reverse-fal:'+digest(logical_input(project,task))
    with ctx.db.lock,ctx.db.conn.transaction():
        c=ctx.db.conn;hit=c.execute('SELECT * FROM creative_cache WHERE cache_key=%s FOR UPDATE',(key,)).fetchone()
        if hit and hit['result'].get('complete'):
            value=hit['result']['value']
            asset=c.execute('SELECT storage_key FROM reverse_assets WHERE id=%s',(value['response_asset_id'],)).fetchone()
            if not asset or not ctx.store.exists(asset['storage_key']):raise ApprovalRequired('Cached paid response missing; restore before any regeneration')
            return {**value,'cache_hit':True}
        if hit and hit['result'].get('owner')!=str(ctx.job['id']):raise AmbiguousCall('Matching provider call is in progress or uncertain; reconcile before a new approval')
        if not hit:
            inserted=c.execute('INSERT INTO creative_cache(cache_key,category,result) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING RETURNING cache_key',
                (key,task['category'],Jsonb({'owner':str(ctx.job['id'])}))).fetchone()
            if not inserted:raise AmbiguousCall('Concurrent matching paid request claimed; no duplicate POST')
    value=_fal_call(ctx,project,task,quote)
    ctx.db.q('UPDATE creative_cache SET result=%s WHERE cache_key=%s',(Jsonb({'complete':True,'value':value}),key))
    return value


def response_text(response):
    for key in ('output','text','response','description','answer'):
        if isinstance(response.get(key),str):return response[key]
    if response.get('choices'):
        return response['choices'][0].get('message',{}).get('content','')
    raise ValueError('Provider did not return readable text')


def parse_object(text):
    text=text.strip()
    if text.startswith('```'):text=text.split('\n',1)[1].rsplit('```',1)[0].strip()
    value=json.loads(text)
    if not isinstance(value,dict):raise ValueError('Expected a JSON object')
    return value
