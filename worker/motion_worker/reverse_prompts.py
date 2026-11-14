"""Timestamped source frames -> one approved OpenAI response -> immutable A/B slots."""
import bisect,copy,datetime as dt,hashlib,json,math,os,re,time
from pathlib import Path
import requests
from psycopg.types.json import Jsonb
from .reverse_media import frame_timing,fetch_private,save_private
from .reverse_render import ffmpeg
from .reverse_provider import fingerprint,asset_uri
from .creative_ledger import Ledger,AmbiguousCall,digest
from .text_video import ApprovalRequired,check_active


def canonical_hash(value):
    def numbers(x):
        if isinstance(x,float) and x.is_integer():return int(x)
        if isinstance(x,list):return [numbers(v) for v in x]
        if isinstance(x,dict):return {k:numbers(v) for k,v in x.items()}
        return x
    return digest(numbers(value))


def motion_lock(doc):
    return canonical_hash({'duration_s':doc['duration_s'],'characters':[x['id'] for x in doc['characters']],
        'locations':[x['id'] for x in doc['locations']],'shots':doc['shots'],'compatibility':doc['compatibility']})


def prompt_text(doc,replacements=None):
    r=replacements or {'characters':{},'locations':{}}
    lines=[f'Recreate this {doc["duration_s"]:.6f}-second sequence. Follow the shot order and timing below.','CAST']
    lines.extend(f'[{c["id"]}]: '+r['characters'].get(c['id'],c['description']) for c in doc['characters'])
    lines.append('LOCATIONS');lines.extend(f'[{l["id"]}]: '+r['locations'].get(l['id'],l['description']) for l in doc['locations'])
    lines.append('LOCKED SHOT DIRECTIONS')
    for s in doc['shots']:
        lines.extend([f'{s["id"]} | {s["start_s"]:.6f}–{s["end_s"]:.6f}s','Setting: ['+s['location_id']+']','Opening: '+s['opening'],'Actions:'])
        lines.extend(f'{a["t0"]:.6f}–{a["t1"]:.6f}s: {a["text"]}' for a in s['actions'])
        lines.extend(['Ending: '+s['ending'],'Camera: '+s['camera'],'Lighting: '+s['lighting'],'Style: '+s['style'],'Required props and interactions: '+s['props']])
    lines.append('Do not add, remove or reorder actions, shots or characters. Keep screen direction, poses, camera and timing. No added captions, logos or dialogue.')
    return '\n'.join(lines)


def selection_frames(timing,shots,start,end):
    pts=timing['pts'];first=bisect.bisect_left(pts,start);last=bisect.bisect_left(pts,end)
    if not 0<=first<last<=len(pts):raise ValueError('Selected range contains no complete video frame')
    t0=pts[first];t1=pts[last] if last<len(pts) else timing['end_s'];parts=[];indices={first,last-1}
    for s in shots:
        a=max(first,s['start_frame']);b=min(last,s['end_frame_exclusive'])
        if a>=b:continue
        parts.append({'id':s['id'],'start_s':round(pts[a]-t0,6),'end_s':round((pts[b] if b<len(pts) else timing['end_s'])-t0,6),'start_frame':a,'end_frame_exclusive':b})
        indices.update([a,(a+b-1)//2,b-1])
    for i in range(math.ceil((t1-t0)*2)):
        k=bisect.bisect_left(pts,t0+i*.5)
        if k<last:indices.add(k)
    if not parts or len(indices)>64:raise ValueError('Too many cuts/frames in this selection; choose a shorter range (maximum 64 evidence frames)')
    return {'start_s':t0,'end_s':t1,'duration_s':round(t1-t0,6),'start_frame':first,'end_frame_exclusive':last,'shots':parts},sorted(indices)


def prepare(ctx,project,spec):
    row=ctx.db.one('SELECT * FROM reverse_prompt_selections WHERE id=%s AND project_id=%s',(spec['selection_id'],project['id']))
    if not row:raise ValueError('Selection not found')
    if row['evidence']:return {'selection_id':row['id'],'cached':True}
    src=ctx.db.one('SELECT * FROM reverse_assets WHERE id=%s AND project_id=%s',(project['source_asset_id'],project['id']))
    source=fetch_private(ctx,src,ctx.path('prompt-source','reference.mp4'));timing=frame_timing(source)
    e,indices=selection_frames(timing,project['analysis']['shots'],**{'start':spec['range']['start_s'],'end':spec['range']['end_s']})
    folder=Path(ctx.path('prompt-frames'));folder.mkdir(parents=True,exist_ok=True)
    expr='+'.join('eq(n\\,'+str(n)+')' for n in indices)
    ffmpeg(['-i',source,'-vf',"select='"+expr+"',scale=768:768:force_original_aspect_ratio=decrease",'-vsync','0','-q:v','3',folder/'frame-%03d.jpg'])
    files=sorted(folder.glob('frame-*.jpg'))
    if len(files)!=len(indices):raise ValueError('Extracted evidence frame count mismatch')
    e['frames']=[]
    for idx,path in zip(indices,files):
        check_active(ctx);a=save_private(ctx,project['id'],path,'prompt_frame',content_type='image/jpeg',metadata={'frame':idx,'source_s':timing['pts'][idx],'selection_id':row['id']})
        e['frames'].append({'asset_id':str(a['id']),'sha256':a['sha256'],'frame':idx,'source_s':timing['pts'][idx],'at_s':round(timing['pts'][idx]-e['start_s'],6)})
    preview=ctx.path('prompt-preview.mp4');ffmpeg(['-i',source,'-vf',f'trim=start_frame={e["start_frame"]}:end_frame={e["end_frame_exclusive"]},setpts=PTS-STARTPTS','-an','-c:v','libx264','-preset','fast','-crf','22','-movflags','+faststart',preview])
    a=save_private(ctx,project['id'],preview,'prompt_clip',content_type='video/mp4',metadata={'selection_id':row['id']});e['preview_asset_id']=str(a['id'])
    e.update(requested=spec['range'],source_sha256=project['source_sha256'],sampling='2 fps plus opening/middle/closing frame of each measured shot; no audio',motion_accuracy='model_estimated_from_samples')
    ctx.db.q('UPDATE reverse_prompt_selections SET evidence=%s WHERE id=%s AND evidence IS NULL',(Jsonb(e),row['id']))
    return {'selection_id':row['id'],'frames':len(indices),'paid_requests':0}


def output_schema():
    def obj(props):return {'type':'object','properties':props,'required':list(props),'additionalProperties':False}
    string={'type':'string'};number={'type':'number'}
    def arr(item):return {'type':'array','items':item}
    entity=obj({'id':string,'description':string})
    shot=obj({'id':string,'start_s':number,'end_s':number,'location_id':string,'opening':string,'actions':arr(obj({'t0':number,'t1':number,'text':string})),'ending':string,'camera':string,'lighting':string,'style':string,'props':string})
    return obj({'summary_th':string,'characters':arr(entity),'locations':arr(entity),'shots':arr(shot),'compatibility':arr(string),'uncertainty':arr(string)})


def validate_document(raw,evidence):
    import jsonschema
    jsonschema.validate(raw,output_schema())
    if len(raw['characters'])>30 or not 1<=len(raw['locations'])<=20:raise ValueError('Invalid entity count')
    ids=[]
    for group,prefix in [('characters','C'),('locations','L')]:
        for item in raw[group]:
            if not re.fullmatch(prefix+r'[1-9][0-9]?',item['id']) or not item['description'].strip() or len(item['description'])>3000 or re.search(r'[\r\n\[\]\x00-\x1f]',item['description']):raise ValueError('Invalid entity slot/description')
            ids.append(item['id'])
    if len(set(ids))!=len(ids):raise ValueError('Duplicate entity slots')
    if len(raw['shots'])!=len(evidence['shots']):raise ValueError('Model changed measured shot count')
    for shot,measured in zip(raw['shots'],evidence['shots']):
        if any(shot[k]!=measured[k] for k in ('id','start_s','end_s')):raise ValueError('Model changed measured shot order or time')
        if shot['location_id'] not in {x['id'] for x in raw['locations']}:raise ValueError('Unknown setting slot')
        if not 1<=len(shot['actions'])<=100:raise ValueError('Missing or excessive action timeline')
        previous=shot['start_s']
        for a in shot['actions']:
            if not shot['start_s']<=a['t0']<=a['t1']<=shot['end_s'] or a['t0']<previous:raise ValueError('Action time outside measured shot/order')
            previous=a['t0']
        text=' '.join([shot[k] for k in ('opening','ending','camera','lighting','style','props')]+[a['text'] for a in shot['actions']])
        if len(text)>30000 or not shot['opening'].strip() or not shot['ending'].strip():raise ValueError('Invalid shot description')
        if any(ref not in ids for ref in re.findall(r'\[([^\]]+)\]',text)):raise ValueError('Unknown template reference')
    # Uncertainty can legitimately say "100% matching is not guaranteed".
    # Never treat that disclosure as an invalid model response.
    if '[MOCK]' in json.dumps(raw):raise ValueError('Placeholder model response')
    raw=copy.deepcopy(raw);raw['duration_s']=evidence['duration_s']
    raw['uncertainty'].append('Interpretation of sampled frames; fast action between samples and original production prompt are not recoverable with certainty. Text-to-video fidelity is not guaranteed.')
    return raw


def rate_config():
    r=json.loads(os.environ.get('MOTION_REVERSE_OPENAI_RATE_JSON','null') or 'null')
    if not r or dt.datetime.now(dt.timezone.utc)>=dt.datetime.fromisoformat(r['valid_until'].replace('Z','+00:00')):raise ApprovalRequired('OpenAI rate expired; configure Railway')
    return r


def _response_call(ctx,project,task,quote):
    if fingerprint('OPENAI_API_KEY')!=quote['key_fingerprints'].get('openai'):raise ApprovalRequired('OpenAI key changed after approval')
    key='reverse:'+quote['binding']+':'+task['slot'];old=ctx.db.one('SELECT * FROM creative_calls WHERE job_id=%s AND call_key=%s',(ctx.job['id'],key))
    if not old:
        if dt.datetime.now(dt.timezone.utc)>dt.datetime.fromisoformat(quote['valid_until'].replace('Z','+00:00')):raise ApprovalRequired('Approval expired')
        status=requests.get('https://api.openai.com/v1/models/'+task['model'],headers={'Authorization':'Bearer '+os.environ['OPENAI_API_KEY']},timeout=25,allow_redirects=False)
        if status.status_code!=200 or status.json().get('id')!=task['model']:raise ApprovalRequired('Configured OpenAI model is unavailable for this account')
        if rate_config()!=task['rate'] or task['model']!=os.environ.get('MOTION_REVERSE_BRAIN_MODEL','gpt-6.1-sol'):raise ApprovalRequired('OpenAI rate/model changed')
    row=Ledger(ctx).reserve(key,'openai',task['model'],'planning',task['payload'],task['usd'])
    if row['status'] in ('complete','reconciled'):return row['result']
    headers={'Authorization':'Bearer '+os.environ['OPENAI_API_KEY'],'Content-Type':'application/json'};base='https://api.openai.com/v1/responses'
    def read(ident):
        if not re.fullmatch(r'resp_[a-zA-Z0-9_-]+',ident):raise ValueError('Invalid saved response ID')
        for attempt in range(4):
            try:
                r=requests.get(base+'/'+ident,headers=headers,timeout=45,allow_redirects=False)
                if r.status_code in (429,500,502,503,504) and attempt<3:time.sleep(2**attempt);continue
                r.raise_for_status();return r.json()
            except (requests.Timeout,requests.ConnectionError):
                if attempt==3:raise
                time.sleep(2**attempt)
    try:
        if row.get('provider_id'):data=read(row['provider_id'])
        else:
            content=[{'type':'input_text','text':json.dumps(task['payload']['evidence'])}]
            for frame in task['payload']['evidence']['frames']:
                content.extend([{'type':'input_text','text':f'Source frame {frame["frame"]}, range time {frame["at_s"]:.6f}s.'},{'type':'input_image','image_url':asset_uri(ctx,project['id'],frame['asset_id']),'detail':'high'}])
            check_active(ctx)
            payload={'model':task['model'],'service_tier':'default','background':True,'store':True,'max_output_tokens':task['payload']['max_output_tokens'],'reasoning':{'effort':task['payload']['reasoning']},'instructions':task['payload']['system'],'input':[{'role':'user','content':content}], 'text':{'format':{'type':'json_schema','name':'reverse_prompt','strict':True,'schema':output_schema()}}}
            r=requests.post(base,headers=headers,json=payload,timeout=60,allow_redirects=False)
            if not r.ok:raise ApprovalRequired('OpenAI submission HTTP '+str(r.status_code)+'; no automatic POST retry')
            data=r.json();ident=data.get('id')
            if not isinstance(ident,str) or not re.fullmatch(r'resp_[a-zA-Z0-9_-]+',ident):raise AmbiguousCall('No accepted response ID; reconcile before retry')
            ctx.db.q('UPDATE creative_calls SET provider_id=%s WHERE id=%s',(ident,row['id']));row['provider_id']=ident
        deadline=time.monotonic()+1200
        while data.get('status') in ('queued','in_progress'):
            check_active(ctx)
            if time.monotonic()>deadline:raise TimeoutError('Resume the saved OpenAI response ID')
            time.sleep(3);data=read(row['provider_id'])
        raw=Path(ctx.path('prompt-response',str(row['id'])+'.json'));raw.write_text(json.dumps(data,ensure_ascii=False))
        a=save_private(ctx,project['id'],raw,'provider_response',content_type='application/json',metadata={'call_id':str(row['id']),'quote_id':quote['id']})
        usage=data.get('usage') or {};rate=task['rate'];actual=None
        if 'input_tokens' in usage and 'output_tokens' in usage:
            long=usage['input_tokens']>272000
            actual=(usage['input_tokens']*rate['input_per_million']*(2 if long else 1)+usage['output_tokens']*rate['output_per_million']*(1.5 if long else 1))/1e6
        value={'response':data,'response_asset_id':str(a['id']),'provider_id':row['provider_id'],'usage':usage}
        ctx.db.q("UPDATE creative_calls SET status='complete',result=%s,usage=%s,actual_usd=%s,updated_at=now() WHERE id=%s",(Jsonb(value),Jsonb({**usage,'cost_basis':'conservative listed token rates; not invoice'}),actual,row['id']))
        return value
    except Exception as e:
        ctx.db.q("UPDATE creative_calls SET status='uncertain',error=%s,updated_at=now() WHERE id=%s AND status='started'",(type(e).__name__,row['id']));raise



def response_call(ctx,project,task,quote):
    # A different quote for identical source/model/instructions must not bill twice.
    key='reverse-openai:'+digest({'source':project['source_sha256'],'project':str(project['id']),'payload':task['payload'],'key':quote['key_fingerprints'].get('openai')})
    with ctx.db.lock,ctx.db.conn.transaction():
        c=ctx.db.conn;hit=c.execute('SELECT * FROM creative_cache WHERE cache_key=%s FOR UPDATE',(key,)).fetchone()
        if hit and hit['result'].get('complete'):return hit['result']['value']
        if hit and hit['result'].get('owner')!=str(ctx.job['id']):raise AmbiguousCall('Matching OpenAI analysis is in progress or uncertain; follow the existing job')
        if not hit:
            inserted=c.execute('INSERT INTO creative_cache(cache_key,category,result) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING RETURNING cache_key',(key,'planning',Jsonb({'owner':str(ctx.job['id'])}))).fetchone()
            if not inserted:raise AmbiguousCall('Matching OpenAI analysis claimed; no duplicate POST')
    value=_response_call(ctx,project,task,quote)
    ctx.db.q('UPDATE creative_cache SET result=%s WHERE cache_key=%s',(Jsonb({'complete':True,'value':value}),key))
    return value


def extract(ctx,project,task,quote):
    selection=ctx.db.one('SELECT * FROM reverse_prompt_selections WHERE id=%s AND project_id=%s',(task['selection_id'],project['id']))
    if not selection or selection['evidence']!=task['payload']['evidence']:raise ApprovalRequired('Prepared evidence changed')
    ident=canonical_hash({'quote':quote['id'],'selection':selection['id']})
    old=ctx.db.one('SELECT id FROM reverse_prompt_versions WHERE id=%s',(ident,))
    if old:return {'version_id':ident,'cached':True}
    paid=response_call(ctx,project,task,quote);data=paid['response']
    if data.get('status')!='completed':raise ValueError('OpenAI response incomplete/refused; raw response saved, no new paid attempt')
    text=''.join(c.get('text','') for o in data.get('output',[]) for c in o.get('content',[]) if c.get('type')=='output_text')
    doc=validate_document(json.loads(text),selection['evidence']);prompt=prompt_text(doc)
    provenance={'provider':'openai','model':task['model'],'provider_id':paid['provider_id'],'response_asset_id':paid['response_asset_id'],'source_sha256':project['source_sha256'],'input':'timestamped_sampled_frames','review':'model_estimated_needs_owner_review','quote_id':quote['id']}
    ctx.db.q('INSERT INTO reverse_prompt_versions(id,project_id,selection_id,document,replacements,prompt_a,prompt_b,locks_hash,provenance) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',(ident,project['id'],selection['id'],Jsonb(doc),Jsonb({'characters':{},'locations':{}}),prompt,prompt,motion_lock(doc),Jsonb(provenance)))
    return {'version_id':ident,'selection_id':selection['id'],'model':task['model']}
