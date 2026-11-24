import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createRankedFalDiscovery,FalRegistryError,registryIssue,buildVideoPayload,discoverRankedModel,estimateVideoPayload,getVideoModel,PREVIOUS_FRAME,validateVideoPayload,type VideoCategory} from './video-registry.js';

const original=process.env.FAL_KEY;
before(()=>{process.env.FAL_KEY='offline-test';});
after(()=>{if(original===undefined)delete process.env.FAL_KEY;else process.env.FAL_KEY=original;});
const imageId='xai/grok-imagine-video/v1.5/image-to-video';
const grokPricing='Priced per second of output video, by resolution: 480p at **$0.08**/sec, 720p at **$0.14**/sec, 1080p at **$0.25**/sec. A 5-second clip costs **$0.40** at 480p, **$0.70** at 720p, and **$1.25** at 1080p. Cost scales linearly with duration. Each reference image adds **$0.01** (1–7 supported). A reference audio clip, if provided, is included at no extra cost.';
const grokEdit='Cost is **$0.05** per second of 480p output video (**$0.07** at 720p) plus **$0.01** per second of input video. For example, a **6-second** 480p video from a 6-second input costs **$0.36**.';
const gemini='Billing is calculated per second of output video, by resolution. For **360p**, your request will cost **$0.03** per second; for **720p**, **$0.10** per second; for **1080p**, **$0.15** per second; and for **4K**, **$0.30** per second. A 10-second **1080p** clip costs **$1.50**, while the same clip at **360p** costs **$0.30**.';
function fixture(endpoint=imageId,category:VideoCategory='image-to-video',description=grokPricing,unit='seconds'){
  const queue='fal-ai/catalog-canonical';const kind=category==='video-editing'?'video-to-video':category;
  const properties:Record<string,any>={prompt:{type:'string',minLength:1,maxLength:80},resolution:{type:'string',enum:['480p','720p','1080p']},generate_audio:{anyOf:[{type:'boolean'},{type:'null'}]}};
  if(category==='video-editing')properties.video_url={type:'string',description:'Input video will be truncated to 8 seconds.'};
  else properties.duration={anyOf:[{type:'integer',minimum:1,maximum:15},{type:'null'}]};
  if(category==='image-to-video')properties.image_url={type:'string'};
  if(category==='video-to-video')properties.reference_video_urls={type:'array',items:{type:'string'},maxItems:3};
  const output={type:'object',required:['video'],properties:{video:{description:'file',$ref:'#/components/schemas/File'}}};
  const input={type:'object',required:['prompt'],properties};
  const json=(schema:unknown)=>({content:{'application/json':{schema}}});
  const model={endpoint_id:endpoint,metadata:{display_name:'Grok Imagine Video 1.5',status:'active',category:kind},
    openapi:{info:{'x-fal-metadata':{endpointId:queue}},components:{schemas:{Input:input,Output:output,File:{type:'object',required:['url'],properties:{url:{type:'string'}}}}},
      paths:{['/'+queue]:{post:{requestBody:json({$ref:'#/components/schemas/Input'})}},['/'+queue+'/requests/{request_id}']:{get:{responses:{'200':json({$ref:'#/components/schemas/Output'})}}}}}};
  const calls:{url:URL;init:RequestInit}[]=[];
  const request:typeof fetch=async(url,init={})=>{
    const u=new URL(String(url));calls.push({url:u,init});
    if(u.hostname==='fal.ai')return new Response('# Example\n\n- **Model ID**: `'+endpoint+'`\n## Pricing\n'+description+'\n\nFor more details, see fal pricing.\n## API Information\n');
    if(u.pathname.endsWith('/pricing'))return Response.json({prices:[{endpoint_id:endpoint,unit_price:0.01,currency:'USD',unit}]});
    if(u.pathname.endsWith('/estimate'))return Response.json({estimate_type:'unit_price',currency:'USD',total_cost:JSON.parse(String(init.body)).endpoints[endpoint].unit_quantity*.01});
    return Response.json({models:u.searchParams.get('endpoint_id')===endpoint?[model]:[],has_more:false});
  };
  return {request,calls,input,model,output};
}

test('exact Arena version, resolution, official queue alias and tier-plus-image quote',async()=>{
  const f=fixture();
  const m=await discoverRankedModel('Grok Imagine Video 1.5 (720p)','image-to-video',f.request);
  assert.ok(m?.available);assert.equal(m.endpoint_id,imageId);assert.deepEqual(m.resolutions,['720p']);
  const p=buildVideoPayload(m,{prompt:'Cup of water',duration:5,resolution:'720P',audio:false,image_url:PREVIOUS_FRAME});
  assert.equal(p.generate_audio,false);assert.equal(p.image_url,PREVIOUS_FRAME);assert.equal(p.duration,5);
  assert.deepEqual(await estimateVideoPayload(m,p,2,f.request),{usd:1.42,quantity:10,unit:'seconds'});
  assert.equal(f.calls.filter(x=>x.init.method==='POST').length,1);
  assert.ok(f.calls.every(x=>new Headers(x.init.headers).has('authorization')===(x.url.origin==='https://api.fal.ai')));
  assert.throws(()=>validateVideoPayload(m,{...p,x:'silently ignored parameter'}),/Unknown fal payload/);
  assert.throws(()=>validateVideoPayload(m,{...p,generate_audio:'false'}),/Invalid fal payload/);
  assert.throws(()=>buildVideoPayload(m,{prompt:'first',duration:4,resolution:'720p',audio:false}),/first frame/);
  await assert.rejects(estimateVideoPayload(m,{...p,resolution:'1080p'},1,f.request),/Unpriced/);
});
test('missing version, wrong category and partial catalog outages are distinguishable',async()=>{
  const f=fixture();assert.equal(await discoverRankedModel('Grok Imagine Video 1.5','text-to-video',f.request),null);
  assert.equal(await discoverRankedModel('SkyReels V4','text-to-video',async()=>Response.json({has_more:false,models:[{endpoint_id:imageId,metadata:{category:'text-to-video',display_name:'SkyReels V4 Lite'}}]})),null);
  assert.equal(await discoverRankedModel('Grok Imagine Video','video-editing',async()=>new Response(null,{status:404})),null);
  await assert.rejects(discoverRankedModel('Grok Imagine Video 1.5','image-to-video',async()=>new Response(null,{status:503})),/503/);
  await assert.rejects(getVideoModel('../oops?key','text-to-video',f.request),/endpoint ID/);
});
test('unaccounted token surcharge, wrong result format or undocumented tariff blocks generation',async()=>{
  const changed=fixture(imageId,'image-to-video',grokPricing+' Input tokens are billed separately.');
  const m=await getVideoModel(imageId,'image-to-video',changed.request);assert.equal(m.endpoint_available,true);assert.equal(m.available,false);assert.ok(m.pricing_description?.includes('tokens'));
  const noSchema=fixture();delete (noSchema.model as any).openapi;
  const listed=await discoverRankedModel('Grok Imagine Video 1.5','image-to-video',noSchema.request);
  assert.equal(listed?.endpoint_available,true);assert.equal(listed?.available,false);assert.ok(listed?.price);
  const noDocs=fixture();
  const verified=await getVideoModel(imageId,'image-to-video',async(url,init)=>String(url).endsWith('/llms.txt')?new Response(null,{status:404}):noDocs.request(url,init));
  assert.ok(verified.endpoint_available);assert.equal(verified.available,false);
  const absent=fixture();absent.output.required=[];assert.equal((await getVideoModel(imageId,'image-to-video',absent.request)).available,false);
  const edit=fixture(imageId,'image-to-video',grokPricing.replace('720p at','a surcharge of $1 plus 720p at'));
  assert.equal((await getVideoModel(imageId,'image-to-video',edit.request)).available,false);
});
test('V2V resolves same exact Gemini version and requires a single reference video',async()=>{
  const id='google/gemini-omni-flash/v1.1/reference-to-video';
  const f=fixture(id,'video-to-video',gemini);f.model.metadata.category='image-to-video';
  const m=await discoverRankedModel('Gemini Omni 1.1 Flash','video-to-video',f.request);
  assert.ok(m?.available);assert.equal(m.category,'video-to-video');
  const p=buildVideoPayload(m,{prompt:'Keep the original movement',duration:5,resolution:'720p',audio:false,video_url:'https://v3.fal.media/a.mp4'});
  assert.deepEqual(p.reference_video_urls,['https://v3.fal.media/a.mp4']);assert.throws(()=>validateVideoPayload(m,{...p,reference_video_urls:[]}),/One video/);
  assert.equal((await estimateVideoPayload(m,p,1,f.request)).usd,.5);
});
test('Grok edit bills measured input and output duration; arbitrary external sources are ineligible',async()=>{
  const id='xai/grok-imagine-video/edit-video',f=fixture(id,'video-editing',grokEdit);
  const m=await discoverRankedModel('Grok Imagine Video','video-editing',f.request);assert.ok(m?.available);
  const scene={prompt:'Change the background',resolution:'720p',duration:8,audio:false,video_url:'https://v3.fal.media/a.mp4'};
  const p=buildVideoPayload(m,scene);assert.ok(!('duration' in p));
  assert.throws(()=>buildVideoPayload(m,{...scene,duration:9}),/duration/);
  assert.throws(()=>buildVideoPayload(m,{...scene,video_url:'https://fal.media.example/a.mp4'}),/fal.media/);
  await assert.rejects(estimateVideoPayload(m,p,1,f.request),/Unpriced/);
  assert.equal((await estimateVideoPayload(m,p,1,f.request,8)).usd,.64);
});
test('documented per-video charge counts paid variants, never seconds',async()=>{
  const id='test/exact-model-v1';const f=fixture(id,'text-to-video','Your request will cost $0.75 per generated video.','videos');
  const m=await getVideoModel(id,'text-to-video',f.request),p=buildVideoPayload(m,{prompt:'A boat',duration:12,resolution:'720p',audio:false});
  assert.deepEqual(await estimateVideoPayload(m,p,2,f.request),{usd:1.5,quantity:2,unit:'videos'});
  await assert.rejects(estimateVideoPayload(m,p,1,async()=>Response.json({estimate_type:'unit_price',currency:'USD',total_cost:4})),/inconsistent/);
});

test('transient pricing and documentation errors keep exact catalog evidence and redact provider error bodies',async()=>{
  const f=fixture();
  const faulty:typeof fetch=async(url,init)=>{
    if(String(url).includes('/pricing?'))return new Response('sensitive-provider-body',{status:403});
    return f.request(url,init);
  };
  const model=await getVideoModel(imageId,'image-to-video',faulty);
  assert.equal(model.endpoint_available,true);assert.equal(model.available,false);assert.equal(model.price,null);
  assert.ok(model.resolutions.includes('720p'));assert.ok(model.billing?.rates['720p']);
  assert.match(model.verification_error||'',/403/);assert.doesNotMatch(JSON.stringify(model),/sensitive-provider-body/);
  const noDocs=await getVideoModel(imageId,'image-to-video',async(url,init)=>{
    if(String(url).endsWith('/llms.txt'))throw new Error('private message');
    return f.request(url,init);
  });
  assert.equal(noDocs.available,false);assert.ok(noDocs.price);assert.match(noDocs.verification_error||'',/เอกสารรุ่น/);
  assert.doesNotMatch(JSON.stringify(noDocs),/private message/);
  const noPrice=await getVideoModel(imageId,'image-to-video',async(url,init)=>String(url).includes('/pricing?')?new Response(null,{status:404}):f.request(url,init));
  assert.equal(noPrice.available,false);assert.equal(noPrice.verification_error,undefined);assert.ok(noPrice.endpoint_available);
  await assert.rejects(getVideoModel(imageId,'image-to-video',async()=>Response.json(null,{status:502})),e=>
    e instanceof FalRegistryError && e.stage==='schema' && e.status===502 && !registryIssue(e).includes('private'));
});
test('fresh per-board pricing coalesces exact IDs and isolates missing rows without carrying rates between refreshes',async()=>{
  const rows=[{name:'Grok Imagine Video 1.5',category:'image-to-video' as const},{name:'Grok Imagine Video 1.5',category:'text-to-video' as const}];
  const textId='xai/grok-imagine-video/v1.5/text-to-video',image=fixture(),text=fixture(textId,'text-to-video');
  let status=200;let count=0;let catalogs=0;
  const request:typeof fetch=async(url,init)=>{
    const u=new URL(String(url));
    if(u.pathname.endsWith('/pricing')){
      count++;
      assert.deepEqual(new Set(u.searchParams.getAll('endpoint_id')),new Set([imageId,textId]));
      return status===200?Response.json({prices:[{endpoint_id:imageId,unit_price:0.01,currency:'USD',unit:'seconds'}],has_more:false}):new Response(null,{status,headers:{'retry-after':'120'}});
    }
    if(u.pathname==='/v1/models'){
      assert.deepEqual(new Set(u.searchParams.getAll('endpoint_id')),new Set([imageId,textId]));catalogs++;
      assert.equal(u.searchParams.get('limit'),'2');return Response.json({models:[image.model,text.model],has_more:false});
    }
    return (u.searchParams.get('endpoint_id')===textId||u.pathname.includes(textId)?text:image).request(url,init);
  };
  const lookup=createRankedFalDiscovery(rows,request);
  const [a,b]=await Promise.all(rows.map(r=>lookup(r.name,r.category)));
  assert.equal(count,1);assert.equal(catalogs,1);assert.ok(a?.available);assert.ok(b?.endpoint_available);assert.equal(b.available,false);
  status=429;
  const again=createRankedFalDiscovery(rows,request),error=await again(rows[0].name,rows[0].category);
  assert.equal(count,2);assert.equal(error?.available,false);assert.match(error?.verification_error||'',/429/);
});

test('official bulk 404 isolates the absent ID and retains its verified sibling',async()=>{
  const textId='xai/grok-imagine-video/v1.5/text-to-video',f=fixture();
  const rows=[{name:'Grok Imagine Video 1.5',category:'image-to-video' as const},{name:'Grok Imagine Video 1.5',category:'text-to-video' as const}];
  const batches:string[][]=[];
  const discover=createRankedFalDiscovery(rows,async(url,init)=>{
    const u=new URL(String(url)),ids=u.searchParams.getAll('endpoint_id');
    if(u.pathname==='/v1/models'){
      batches.push(ids);
      if(ids.includes(textId))return new Response(null,{status:404});
    }
    return f.request(url,init);
  });
  const [image,text]=await Promise.all(rows.map(r=>discover(r.name,r.category)));
  assert.ok(image?.available);assert.equal(text,null);assert.deepEqual(batches,[[imageId,textId],[imageId],[textId]]);
});
test('catalog retries a short 429 once and searches a new Arena name just once across categories',async()=>{
  const calls:string[]=[];
  const discover=createRankedFalDiscovery([],async(url,init)=>{
    const u=new URL(String(url));assert.equal(u.origin,'https://api.fal.ai');assert.ok(new Headers(init?.headers).has('authorization'));
    calls.push(String(url));
    return calls.length===1 ? new Response(null,{status:429,headers:{'retry-after':'0'}}) : Response.json({models:[],has_more:false});
  });
  const models=await Promise.all([discover('Future Model 1.4','text-to-video'),discover('Future Model 1.4','video-editing')]);
  assert.deepEqual(models,[null,null]);assert.equal(calls.length,2);assert.equal(new Set(calls).size,1);
});
