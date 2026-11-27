import { strict as assert } from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import pg from 'pg';
import { registerUgc } from './ugc.js';
import { videoProvider, type DraftDocument } from './ugc-contract.js';
import { createOpenAIModelCatalog } from './openai-models.js';
import { MissingEndpoint, UGC_IMAGE_REFERENCES, type FalVideoModel } from './video-registry.js';

const endpoint='minimax/h3/image-to-video';
test('product through confirmed quote, real queue/render/export, and no duplicate paid requests', {skip:!process.env.UGC_TEST_DATABASE_URL, timeout:360000}, async()=>{
  const pool=new pg.Pool({connectionString:process.env.UGC_TEST_DATABASE_URL});
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  const temp=await mkdtemp(join(tmpdir(),'ugc-media-test-'));
  let server:ReturnType<typeof serve>|undefined;
  try {
    assert.equal((await pool.query('select current_database() as db')).rows[0].db,'ugc_test');
    await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    const migrations=join(repo,'api/migrations');
    for (const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(join(migrations,file),'utf8'));
      await pool.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
    }
    await pool.query("INSERT INTO integrations(provider,data) VALUES('text_video_worker',$1)",[JSON.stringify({
      ugc_version:3,ugc_r2:true,fal:true,eleven:true,voice_id:'voice-fixture',voice_model:'eleven_v3',voice_usd_per_1000_characters:.1,
      capabilities_checked_at:Math.floor(Date.now()/1000),audio_pricing_source:'https://elevenlabs.io/pricing/api',
    })]);
    const app=new Hono(),source='https://example.org/trend',buy='https://store.example/sku-a';
    const database='01552600-a420-42f5-9a47-d496d99389df', page='19552600-a420-42f5-9a47-d496d99389df';
    const product={name:'รองเท้า Orion',variant:'A',price:'990',promo:'ส่งวันนี้',selling_points:'พื้นยาง',order_url:buy};
    const options={FIRECRAWL_API_KEY:'mock',FAL_KEY:'mock',OPENAI_API_KEY:'mock',UGC_NOTION_TOKEN:'mock',UGC_NOTION_DATABASE_IDS:database};
    let rate=.1,openai=0,lookups=0,reads=0,imageRate=.15,browserBase='';
    const creatorEndpoint='xai/grok-imagine-video/v1.5/image-to-video';
    const altEndpoint='fixture/new-speaker/image-to-video';
    let catalogMode='normal',brainReads=0,fcSearches=0,fcReads=0,intakePosts=0,ideaModel='';
    const brains=createOpenAIModelCatalog({env:options,responsesJson:true,request:async()=>{
      brainReads++;
      if(catalogMode==='down')return Response.json({}, {status:503});
      const ids=catalogMode==='changed'?['gpt-6.2-sol','gpt-7.1-terra']:['gpt-6.2-sol'];
      return Response.json({data:[...ids.map(id=>({id})),{id:'gpt-8-sol',capabilities:{responses:false}},{id:'gpt-image-2'}]});
    }});
    const footage=join(temp,'product.png');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x240','-frames:v','1','-threads','1',footage]);
    const fixture=await readFile(footage);
    const schema={type:'object',additionalProperties:false,required:['prompt','image_url'],properties:{
      prompt:{type:'string'},image_url:{type:'string',format:'uri'},duration:{enum:[4,5,10,12]},generate_audio:{type:'boolean'},
      resolution:{enum:['768P']}}};
    async function readVideo(id:string,category:FalVideoModel['category']):Promise<FalVideoModel>{
        lookups++;assert.equal(category,'image-to-video');
        if(catalogMode==='down')throw Error('provider unavailable');
        if(id===creatorEndpoint&&catalogMode==='removed'||id===altEndpoint&&!['changed','removed'].includes(catalogMode)||
          ['alibaba/wan-3.0/image-to-video','google/gemini-omni-flash/v1.1/image-to-video'].includes(id))throw new MissingEndpoint();
        if(id===creatorEndpoint||id===altEndpoint){
          return {endpoint_id:id,category,name:id===creatorEndpoint?'Grok Imagine 1.5':'Wan 3.0',available:true,resolutions:['720p'],durations:[3,4,5,10,12],audio:true,
            input_schema:{...schema,properties:{...schema.properties,duration:{enum:[3,4,5,10,12]},resolution:{enum:['720p']}}},
            schema_hash:'creator-schema',price:{unit:'seconds',unit_price:.01,currency:'USD'},billing:{rates:{'720p':.14},reference_image_usd:.01},
            source_url:'https://fal.ai/models/'+id,checked_at:new Date().toISOString()} satisfies FalVideoModel;
        }
        assert.equal(id,endpoint);
        return {endpoint_id:id,category,name:'H3',available:true,resolutions:['768P'],durations:[4,5,10,12],audio:true,
          input_schema:schema,schema_hash:'test-schema',price:{unit:'seconds',unit_price:rate,currency:'USD'},
          billing:{rates:{'768p':rate}},source_url:'https://fal.ai/models/'+id,checked_at:new Date().toISOString()} satisfies FalVideoModel;
      }
    const appUgc=registerUgc(app,pool,{
      guard:async(c,next)=>{if(c.req.header('x-test')!=='owner'&&!(browserBase&&c.req.header('x-motion-ui')==='1'))return c.json({error:'unauthorized'},401);await next();},
      workerGuard:async(c,next)=>{if(c.req.header('x-internal-token')!=='test-worker')return c.json({error:'unauthorized'},401);await next();},
      env:options,models:brains,firecrawlFetch:async(url,init)=>{
        const body=JSON.parse(String(init?.body));
        if(String(url).endsWith('/search')){
          assert.match(body.query,/^site:shopee\.co\.th /);fcSearches++;
          if(catalogMode==='research-down')return Response.json({success:false},{status:503});
          return Response.json({success:true,creditsUsed:2,data:{web:Array.from({length:5},(_,i)=>({url:'https://shopee.co.th/product/22/'+(70+i)}))}});
        }
        assert.match(body.url,/^https:\/\/shopee\.co\.th\/product\/22\//);assert.equal(body.maxAge,0);fcReads++;
        const i=Number(body.url.split('/').at(-1))-70;
        return Response.json({success:true,creditsUsed:1,data:{metadata:{url:body.url,statusCode:200},
          markdown:'# '+['แก้วเก็บความเย็น','แก้วพร้อมฝา','แก้วน้ำสแตนเลส','กระบอกน้ำ','ขวดน้ำ'][i]+'\n'+(i?'':'ขายแล้ว 128 ชิ้น\n')+'฿299\n## การจัดส่ง\nHome Studio\nแชทเลย'}});
      },
      storage:{sign:async(key,download)=>(browserBase?browserBase+'/qa/assets/':'https://fixture.invalid/')+key+(download?'?attachment=1':'')},
      references:{put:async(key,data)=>{const file=join(temp,'r2',key);await mkdir(dirname(file),{recursive:true});await writeFile(file,data);},
        sign:async(key)=>(browserBase?browserBase+'/qa/r2/':'https://r2-fixture.invalid/')+key},
      notionFetch:async(input)=>{
        const url=new URL(String(input));
        assert.equal(url.hostname,'api.notion.com');
        const record={id:page,parent:{database_id:database},properties:{
          Product:{id:'title',type:'title',title:[{plain_text:product.name}]},
          Price:{id:'price',type:'number',number:990},
          Shop:{id:'shop',type:'url',url:buy},
        }};
        if(url.pathname==='/v1/databases/'+database)return Response.json({properties:{
          Product:{id:'title',name:'Product',type:'title'}, Price:{id:'price',name:'Price',type:'number'}, Shop:{id:'shop',name:'Shop',type:'url'}}});
        if(url.pathname.endsWith('/query'))return Response.json({results:[record]});
        assert.equal(url.pathname,'/v1/pages/'+page);return Response.json(record);
      },
      image:async(endpoint,prompt,portrait)=>({endpoint_id:endpoint,model_name:'Nano Banana Pro',resolution:'1K',
        payload:{prompt,image_urls:UGC_IMAGE_REFERENCES.slice(0,portrait?2:1),num_images:1,output_format:'jpeg',resolution:'1K',aspect_ratio:'9:16',enable_web_search:false},
        schema_hash:'image-fixture-schema',billing_quantity:1,billing_unit:'images',unit_usd:imageRate,estimated_usd:imageRate,
        account_unit_usd:imageRate,pricing_source:'https://fal.ai/models/'+endpoint,pricing_checked_at:new Date().toISOString()}),
      response:async(body,opts)=>{
        const data=JSON.parse(body.input);
        if(data.listings){
          assert.equal(body.tools,undefined);
          ideaModel=body.model;
          return {id:'resp_idea',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({picks:data.listings.map((p:any)=>({id:p.id,angle:'demonstration'}))})}]}]};
        }
        if(data.reviewer!==undefined){
          if(body.instructions.includes('product_name')&&!opts.responseId)intakePosts++;
          const id='resp_ugc_creator';await opts.onAccepted?.(id);
          return {id,status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({
            ...(body.instructions.includes('product_name')?{product_name:data.product.name||(data.brief.includes('กล่อง')?'กล่องเกม PS5 After the Tide':'แก้วเก็บความเย็น'),reviewer_kind:data.brief.includes('คลิปคนจริง')?'clip':'ai',presenter_direction:'ผู้หญิงยกสินค้าให้กล้องเห็นแล้วพูดภาษาไทย'}:{}),
            caption:'ดูรายละเอียดสินค้า',
            angles:[
              {hook:'ส่องหน้ากล่อง',opening:'มาดูกล่องเกมนี้กัน',middle:'หน้ากล่องมีชื่อเกมและโลโก้ PS5',close:'ดูรายละเอียดที่หน้าร้าน'},
              {hook:'เลือกให้ตรงเครื่อง',opening:'เล่นบนเครื่องไหนกัน',middle:'ดูแถบด้านบน มีเครื่องหมาย PS5',close:'ดูรุ่นที่หน้าร้านได้เลย'},
              {hook:'กล่องสำหรับสะสม',opening:'ชอบเก็บกล่องเกมไหม',middle:'ลองดูภาพปกและรายละเอียดบนกล่อง',close:'กดดูรายละเอียดได้เลย'},
            ],
          })}]}]};
        }
        assert.equal(body.model,'gpt-6.2-sol');
        if(!opts.responseId){openai++;await opts.onAccepted!('resp_ugc');return {id:'resp_ugc',status:'in_progress'};}
        reads++;assert.equal(opts.responseId,'resp_ugc');
        return {id:'resp_ugc',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({
          hooks:['หารองเท้าพื้นยางอยู่หรือเปล่า','รองเท้าคู่นี้มีอะไร','ลองดูรองเท้า Orion'],caption:'ลองดูสินค้าของร้าน',
          scenes:[
            {seconds:4,narration:'รองเท้าคู่นี้มีอะไร',visual:'Open on the exact shoes',camera:'close up',mode:'original'},
            {seconds:7,narration:'คู่นี้ใช้พื้นยาง',visual:'Tilt slowly over the sole',camera:'slow tilt',mode:'fal'},
            {seconds:9,narration:'ดูรายละเอียดได้ที่หน้าร้าน',visual:'Return to the product photo',camera:'static',mode:'original'},
          ],
        })}]}]};
      },
      videoDiscovery:async seed=>({ids:[...new Set([...seed,...(['changed','removed'].includes(catalogMode)?[altEndpoint]:[])])],load:id=>readVideo(id,'image-to-video')}),
      video:{...videoProvider,model:readVideo,price:async(m,p)=>({usd:Math.round((Number(p.duration)*m.billing!.rates[String(p.resolution).toLowerCase()]+(m.billing!.reference_image_usd||0))*100)/100,unit:'seconds',quantity:Number(p.duration)})},
    });
    app.get('/app',async c=>c.html(await readFile(join(repo,'api/src/ui.html'),'utf8')));
    app.get('/app/ugc.js',async c=>c.text(await readFile(join(repo,'api/src/ugc-ui.js'),'utf8'),200,{'Content-Type':'text/javascript'}));
    app.get('/app/text-video.js',async c=>c.text(await readFile(join(repo,'api/src/text-video-ui.js'),'utf8'),200,{'Content-Type':'text/javascript'}));
    app.get('/app/api/me',c=>c.json({ui_enabled:true,authed:true}));
    app.get('/app/api/text-video/config',c=>c.json({brains:['gpt-6.2-sol'],default_brain:'gpt-6.2-sol',
      reasoning_levels:['low','medium','high'],default_reasoning:'high',durations:[60,90,120],
      narration_styles:[{id:'standard',label:'ปกติ'}],openai_configured:true}));
    app.get('/app/api/text-video/plans',c=>c.json({plans:[]}));
    app.get('/app/api/video-intelligence/arena',c=>c.json({categories:[]}));

    app.get('/qa/counters',async c=>c.json({brainReads,lookups,fcSearches,fcReads,ideaModel,jobs:(await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n}));
    app.get('/qa/:bucket/*',async c=>{
      const bucket=c.req.param('bucket');
      const key=c.req.path.split('/').slice(3).join('/');
      if(!['r2','assets'].includes(bucket)||!key.split('/').every(part=>/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/.test(part)))return c.notFound();
      const data=await readFile(join(temp,bucket==='r2'?'r2':'',key)).catch(()=>null);
      if(!data)return c.notFound();
      const type=key.endsWith('.mp4')||data.toString('ascii',4,8)==='ftyp'?'video/mp4':'image/jpeg';
      const range=/^bytes=(\d+)-(\d*)$/.exec(c.req.header('range')||'');
      const start=range?Number(range[1]):0, end=range?.[2]?Math.min(data.length-1,Number(range[2])):data.length-1;
      if(start>end)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+data.length}});
      return new Response(new Uint8Array(data.subarray(start,end+1)),{status:range?206:200,
        headers:{'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':String(end-start+1),
          ...(range?{'Content-Range':`bytes ${start}-${end}/${data.length}`}:{})}});
    });
    app.post('/qa/run-next',async c=>{
      assert.ok(browserBase);
      const j=(await pool.query("SELECT id FROM jobs WHERE status='NEW' AND package->'ugc'->>'draft_id'=$1 ORDER BY created_at LIMIT 1",[c.req.query('draft')])).rows[0];
      if(!j)return c.json({error:'queue is empty'},404);
      return c.json(await runWorker(j.id));
    });
    app.post('/qa/catalog-mode',async c=>{assert.ok(browserBase);catalogMode=(await c.req.json()).mode;return c.json({ok:true});});
    app.post('/qa/image-rate',async c=>{assert.ok(browserBase);imageRate=(await c.req.json()).rate;return c.json({ok:true});});
    const headers={'x-test':'owner','content-type':'application/json'};
    const request=async(path:string,method='GET',body?:unknown,key?:string)=>app.request('/app/api/ugc'+path,
      {method,headers:{...headers,...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const ok=async(r:Response)=>{const body=await r.json() as any;assert.ok(r.ok,JSON.stringify(body));return body;};
    const jobs=async()=>Number((await pool.query("SELECT count(*) FROM jobs WHERE package ? 'ugc'")).rows[0].count);
    assert.equal((await app.request('/app/api/ugc/drafts')).status,401);
    assert.equal((await app.request('/internal/ugc/check-dispatch',{method:'POST'})).status,401);
    await ok(await request('/notion/config','PUT',{database_id:database,fields:{name:'title',price:'price',order_url:'shop',variant:'',promo:'',selling_points:'',media:''}}));
    assert.equal((await ok(await request('/notion/products'))).items[0].name,product.name);
    const creation=randomUUID();
    let draft=await ok(await request('/drafts','POST',{name:product.name,evidence:[{kind:'demand',title:'Trend',quote:'Ranking signal',date:'2026-11-27',url:source}]},creation));
    assert.equal((await ok(await request('/drafts','POST',{name:product.name},creation))).id,draft.id);
    assert.equal(draft.document.product.order_url,'');
    assert.equal(draft.document.duration,18);
    assert.equal(draft.document.endpoint,creatorEndpoint);
    assert.equal(draft.document.resolution,'720p');
    // Simulate a legacy edit containing an earlier production job. Its old cut still runs.
    const oldDoc={...draft.document,duration:20,endpoint:'minimax/h3-max/image-to-video',resolution:'768P'};
    delete oldDoc.reviewer;
    const priorJob=(await pool.query("INSERT INTO jobs(kind,status,package) VALUES('text_video','CANCELLED','{}') RETURNING id")).rows[0].id;
    await pool.query('UPDATE ugc_drafts SET document=$2,source_job_id=$3 WHERE id=$1',[draft.id,JSON.stringify(oldDoc),priorJob]);
    draft=await ok(await request('/drafts/'+draft.id));
    const draftPath='/drafts/'+draft.id;
    const imported=await ok(await request(draftPath+'/import-notion','POST',{page_id:page}));
    assert.equal(imported.product.order_url,buy);
    assert.equal(imported.product.price,'990');
    const media=await ok(await app.request('/app/api/ugc'+draftPath+'/media',{method:'POST',headers,body:new Uint8Array(fixture)}));
    const patch=async(doc:DraftDocument)=>{
      draft=await ok(await request(draftPath,'PATCH',{revision:draft.revision,document:doc}));
    };
    await patch({...draft.document,product,endpoint,resolution:'768P',brief:'วางรองเท้าให้เห็นพื้นยาง'});
    const startRevision=draft.revision, planKey=randomUUID();
    await ok(await request(draftPath+'/suggest','POST',{revision:startRevision},planKey));
    for (let i=0;i<70;i++){
      await appUgc.pump();
      draft=await ok(await request(draftPath));
      if(draft.planning.state==='done')break;
      assert.notEqual(draft.planning.state,'failed',draft.planning.error);
      await new Promise(r=>setTimeout(r,100));
    }
    await ok(await request(draftPath+'/suggest','POST',{revision:startRevision},planKey));
    assert.equal(openai,1);
    assert.equal(reads,1);
    assert.equal(draft.document.hooks.length,3);
    assert.equal(draft.document.scenes[1].media_id,media.id);
    const getQuote=(confirmed:unknown=true)=>request(draftPath+'/quote','POST',{revision:draft.revision,product_confirmed:confirmed});
    const produce=(quote:any,approved:unknown=true)=>request(draftPath+'/produce','POST',{revision:quote.revision||draft.revision,quote_id:quote.id,approved});
    assert.equal((await getQuote(false)).status,409);
    assert.equal((await produce({id:randomUUID()})).status,409);
    await patch({...draft.document,product:{...product,order_url:source}});
    assert.equal((await getQuote()).status,409);
    await patch({...draft.document,product,hook:'ส่งฟรี วันนี้'});
    assert.equal((await getQuote()).status,409);
    await patch({...draft.document,hook:draft.document.hooks[0]});
    let quote=await ok(await getQuote());
    assert.equal(quote.fal[0].billed_seconds,10);
    assert.equal(quote.fal[0].edited_seconds,7);
    assert.equal(quote.fal_usd,1);
    assert.ok(quote.eleven_usd>0);
    assert.equal(await jobs(),0);
    assert.equal((await produce(quote,false)).status,409);
    rate=.11;
    assert.equal((await produce(quote)).status,409);
    assert.equal(await jobs(),0);
    quote=await ok(await getQuote());
    await patch({...draft.document,caption:'แคปชันที่แก้แล้ว'});
    assert.equal((await produce(quote)).status,409);
    quote=await ok(await getQuote());
    await pool.query("UPDATE ugc_drafts SET quote=jsonb_set(quote,'{expires_at}', '\"2000-01-01T00:00:00Z\"'::jsonb) WHERE id=$1",[draft.id]);
    assert.equal((await produce(quote)).status,409);
    assert.equal(await jobs(),0);
    quote=await ok(await getQuote());
    assert.equal(quote.fal_usd,1.1);
    const [a,b]=await Promise.all([produce(quote).then(ok),produce(quote).then(ok)]);
    assert.equal(a.job_id,b.job_id);
    assert.equal(await jobs(),1);
    const queued=await ok(await request('/jobs/'+a.job_id));
    assert.equal(queued.status,'NEW');
    assert.equal(queued.scenes.length,3);
    const dispatch=async(job:string,id:string,slot:string)=>app.request('/internal/ugc/check-dispatch',{method:'POST',headers:{'x-internal-token':'test-worker','content-type':'application/json'},
      body:JSON.stringify({job_id:job,approval_id:id,slot})});
    assert.equal((await dispatch(a.job_id,randomUUID(),'fal:shot_02')).status,409);
    // Verify changed rates are also caught after queueing, immediately before a POST.
    await pool.query("UPDATE jobs SET status='RENDERING' WHERE id=$1",[a.job_id]);
    rate=.12;assert.equal((await dispatch(a.job_id,quote.id,'fal:shot_02')).status,409);rate=.11;
    await pool.query("UPDATE jobs SET status='NEW' WHERE id=$1",[a.job_id]);
    assert.equal((await pool.query('SELECT count(*) FROM text_video_calls')).rows[0].count,'0');
    server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
    await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const port=address.port;
    async function runWorker(job:string){
      const proc=spawn(process.env.UGC_TEST_PYTHON||'python3',['worker/tests/ugc_mock_worker.py',job],{
        cwd:repo,env:{...process.env,PYTHONPATH:'worker',DATABASE_URL:process.env.UGC_TEST_DATABASE_URL,UGC_TEST_ASSETS:temp,
          MOTION_WORKDIR:join(temp,'render'),MOTION_INTERNAL_TOKEN:'test-worker',MOTION_API_INTERNAL_URL:'http://ugc-fixture',
          UGC_TEST_API:'http://127.0.0.1:'+port,FAL_KEY:'mock',ELEVENLABS_API_KEY:'mock'},
        stdio:['ignore','pipe','pipe'],
      });
      let out='',err='';
      proc.stdout.on('data',chunk=>out+=chunk);proc.stderr.on('data',chunk=>err+=chunk);
      const [code]=await once(proc,'close');
      assert.equal(code,0,err||out);
      return JSON.parse(out.trim().split('\n').at(-1)!);
    }
    const worker1=await runWorker(a.job_id);
    assert.deepEqual(worker1.calls,['eleven','eleven','eleven','fal']);
    assert.equal(worker1.result.duration,20);
    const done=await ok(await request('/jobs/'+a.job_id));
    assert.equal(done.status,'READY_TO_POST');
    assert.ok(done.video.endsWith('/ugc/final.mp4'));
    assert.ok(done.download.endsWith('?attachment=1'));
    assert.equal(done.notes.order_url,buy);
    assert.ok(done.scenes.every((s:any)=>s.state==='done'));
    assert.equal(done.fal_usage.length,1);
    assert.equal(done.fal_usage[0].estimated_usd,1.1);
    assert.equal(done.fal_usage[0].actual_usd,.98);
    assert.ok((await readFile(join(temp,'jobs',a.job_id,'ugc','subtitles.ass'),'utf8')).includes('990 บาท'));
    draft=await ok(await request(draftPath+'/edit','POST',{job_id:a.job_id,scene:'shot_02'}));
    let repair=await ok(await getQuote());
    assert.deepEqual(repair.pending_slots,['fal:shot_02']);
    // Recut only from the originally completed job, retaining all paid clips and narration.
    await pool.query('UPDATE ugc_drafts SET regenerate_scene=NULL,quote=NULL WHERE id=$1',[draft.id]);
    await patch({...draft.document,product:{...product,price:'1190'},cta:'ไปที่ร้าน',scenes:draft.document.scenes.map((s:any,i:number)=>({...s,subtitle:i===1?'พื้นยางของรุ่นนี้':''}))});
    const recut=await ok(await getQuote());
    assert.equal(recut.total_usd,0);
    assert.deepEqual(recut.pending_slots,[]);
    const c=await ok(await produce(recut));
    const worker2=await runWorker(c.job_id);
    assert.deepEqual(worker2.calls,[]);
    const quiet=await ok(await request('/jobs/'+c.job_id));
    assert.equal(quiet.fal_usage[0].reused,true);
    assert.equal(quiet.fal_usage[0].actual_usd,null);
    assert.ok((await readFile(join(temp,'jobs',c.job_id,'ugc','subtitles.ass'),'utf8')).includes('1190 บาท'));
    assert.ok((await readFile(join(temp,'jobs',c.job_id,'ugc','subtitles.ass'),'utf8')).includes('พื้นยางของรุ่นนี้'));
    assert.equal((await ok(await produce(quote))).job_id,a.job_id);
    draft=await ok(await request(draftPath+'/edit','POST',{job_id:c.job_id,scene:'shot_02'}));
    await patch({...draft.document,duration:30,scenes:draft.document.scenes.map((s:any,i:number)=>({...s,seconds:[4,11,15][i]}))});
    repair=await ok(await getQuote());
    const d=await ok(await produce(repair));
    const worker3=await runWorker(d.job_id);
    assert.deepEqual(worker3.calls,['fal']);
    assert.equal(worker3.result.duration,30);
    await pool.query("UPDATE jobs SET status='FAILED' WHERE id=$1",[d.job_id]);
    await pool.query("UPDATE text_video_calls SET status='unknown' WHERE job_id=$1 AND slot='fal:shot_02'",[d.job_id]);
    assert.equal((await getQuote()).status,409);
    assert.equal((await request(draftPath+'/edit','POST',{job_id:d.job_id})).status,409);
    await pool.query("UPDATE text_video_calls SET status='accepted' WHERE job_id=$1 AND slot='fal:shot_02'",[d.job_id]);
    const polling=await ok(await getQuote());
    assert.deepEqual(polling.pending_slots,[]);
    await pool.query("UPDATE text_video_calls SET status='failed' WHERE job_id=$1 AND slot='fal:shot_02'",[d.job_id]);
    const retry=await ok(await getQuote());
    assert.deepEqual(retry.pending_slots,['fal:shot_02']);
    assert.equal((await produce(polling)).status,409);
    assert.equal(await jobs(),3);
    await pool.query("UPDATE text_video_calls SET status='done' WHERE job_id=$1 AND slot='fal:shot_02'",[d.job_id]);
    await pool.query("UPDATE jobs SET status='READY_TO_POST' WHERE id=$1",[d.job_id]);
    draft=await ok(await request(draftPath+'/edit','POST',{job_id:d.job_id}));
    assert.equal((await request(draftPath,'PATCH',{revision:draft.revision,document:{...draft.document,duration:31}})).status,422);
    assert.ok(lookups>4);
    const initialJobs=await jobs(), key=randomUUID(), intake={brief:'ให้ผู้หญิงถือแก้วเก็บความเย็นพูดกับกล้อง',endpoint:creatorEndpoint};
    const [intakeA,intakeB]=await Promise.all([request('/prepare','POST',intake,key),request('/prepare','POST',intake,key)]);
    assert.equal((await ok(intakeA)).id,key);assert.equal((await ok(intakeB)).id,key);
    for(let i=0;i<30;i++){
      await appUgc.pump();
      if((await ok(await request('/drafts/'+key))).planning?.state==='done')break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const prepared=await ok(await request('/drafts/'+key));
    assert.equal(prepared.document.product.name,'แก้วเก็บความเย็น');
    assert.equal(prepared.document.scenes.length,3);assert.equal(prepared.document.reviewer.kind,'ai');
    assert.equal(prepared.document.reviewer.opening_id,null);assert.equal(prepared.document.product.price,'');
    assert.equal(prepared.document.scenes[0].media_id,null);assert.match(prepared.document.scenes[0].visual,/ผู้หญิง/);
    assert.equal(intakePosts,1);assert.equal(await jobs(),initialJobs);
    assert.equal((await request('/prepare','POST',{...intake,brief:'อีกบรีฟ'},key)).status,422);
    assert.equal((await request('/drafts/'+key+'/quote','POST',{revision:prepared.revision,product_confirmed:true})).status,409);
    const before=lookups;
    const both=await Promise.all([request('/catalog/video?refresh=1'),request('/catalog/video?refresh=1')]);
    const snapshots=await Promise.all(both.map(ok));
    assert.deepEqual(snapshots[0],snapshots[1]);assert.equal(lookups-before,3);
    assert.deepEqual(snapshots[0].models[0].rates[0],{resolution:'720p',unit:'seconds',unit_usd:.14,image_usd:.01});
    if(process.env.UGC_TEST_BROWSER==='1'){
      browserBase='http://127.0.0.1:'+port;
      const proc=spawn(process.env.UGC_TEST_PYTHON||'python3',['worker/tests/ugc_mock_browser.py',browserBase,temp],
        {cwd:repo,env:process.env,stdio:['ignore','pipe','pipe']});
      let out='',err='';
      proc.stdout.on('data',chunk=>out+=chunk);proc.stderr.on('data',chunk=>err+=chunk);
      const [code]=await once(proc,'close');
      assert.equal(code,0,err||out);
      console.info(out.trim());
    }
  } finally {
    server?.close();
    await pool.end();
    if(!process.env.UGC_KEEP_FIXTURE)await rm(temp,{recursive:true,force:true});
    else console.info('UGC fixture artifacts',temp);
  }
});
