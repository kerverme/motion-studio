import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {ensureVideoKnowledge,buildKnowledge,retrieveKnowledge} from './video-director-knowledge.js';
import {directVideoScene,routeVideoModel,chooseGenerationSeconds,StoryBibleSchema,type DirectionInput} from './video-director.js';

const db=new PGlite();
before(async()=>{
  await db.exec(readFileSync(new URL('../migrations/038_video_director.sql',import.meta.url),'utf8'));
  await db.exec('CREATE TABLE jobs (id uuid PRIMARY KEY)');
  await db.exec(readFileSync(new URL('../migrations/039_video_model_benchmarks.sql',import.meta.url),'utf8'));
});
after(()=>db.close());
const bible={characters:[{id:'C1',description:'Courier in a blue jacket'}],locations:[{id:'L1',description:'Tiled station platform'}],
  props:[{id:'P1',description:'Brown leather wallet'}],visual_style:'Softly painted panels',lighting:'Diffuse skylight',continuity_rules:['Keep the courier screen left.']};
const scene={id:'shot_01',narration:'กระเป๋าสตางค์หล่นจากมือ',visual_prompt:'A courier bumps the barrier and a brown wallet slips from his fingers.',end_frame:'The wallet rests against the barrier.',
  direction:{scene_type:'action',duration_seconds:5,purpose:'Establish accidental loss',subjects:['C1','P1'],setting:'L1',camera:'Medium shot with a slow pan',lighting:'Diffuse skylight',
    actions:[{id:'bump',actor:'C1',action:'The courier bumps the barrier.',after:[]},{id:'drop',actor:'P1',action:'The wallet falls to the floor.',intent:'accidental' as const,after:['bump']}],opening_state:'The courier approaches the barrier.',closing_state:'The wallet rests against the barrier.'}};
const base={endpoint_id:'acme/v1/text-to-video',name:'Acme v1',category:'text-to-video',available:true,input_schema:{properties:{prompt:{type:'string',maxLength:5000,description:'Enter a visual subject and action.'}}},schema_hash:'initial',audio:false,resolutions:['720p'],durations:[4,6,10],checked_at:new Date().toISOString(),source_url:'https://fal.ai/models/acme/v1/text-to-video/api',rank:1,estimated_usd:2};
const data=(candidate=base):DirectionInput=>({scene:structuredClone(scene),bible,index:0,candidates:[candidate],mode:'best_value',budget_usd:5,resolution:'720p'});
const page=(model=base,tag='static tracking')=>({url:model.source_url.replace('/api','/llms.txt'),text:'# Video\n> '+tag+'\n### Input Schema\n- **`prompt`** optional: e.g. Moving subject.\n### Output Schema'});
test('Story Bible prevents cross-category ID collisions; duration chooses the shortest valid billable clip',()=>{
  assert.equal(chooseGenerationSeconds([10,3,6],4.7),6);assert.equal(chooseGenerationSeconds([3],4),null);
  assert.equal(StoryBibleSchema.safeParse({...bible,props:bible.characters}).success,false);
});
test('knowledge research coalesces reads, caches, versions changed docs/schema and retrieves endpoint evidence',async()=>{
  let reads=0;const t=new Date('2026-01-01'),m={...base,endpoint_id:'mock/registry-cache'};
  const read=async()=>{reads++;return page(m);};
  const [a,b]=await Promise.all([ensureVideoKnowledge(db,m,{read,now:t}),ensureVideoKnowledge(db,m,{read,now:t})]);
  assert.equal(a.version,b.version);assert.equal(reads,1);
  await ensureVideoKnowledge(db,m,{read,now:t});assert.equal(reads,1);
  const c=await ensureVideoKnowledge(db,m,{read:async()=>page(m,'new guidance'),now:new Date(+t+90000000)});
  assert.notEqual(a.version,c.version);
  const updated=await ensureVideoKnowledge(db,{...m,schema_hash:'changed'},{read,now:t});assert.notEqual(updated.version,a.version);
  assert.equal(retrieveKnowledge(a,'static tracking')[0].tag,'description');
  assert.equal((await db.query('SELECT * FROM video_prompt_knowledge WHERE endpoint_id=$1',[m.endpoint_id])).rows.length,3);
});
test('router filters category, availability, rank, supported resolution/duration/audio/price; value differs from quality',()=>{
  const cheap={...base,endpoint_id:'acme/v2',rank:3,estimated_usd:.25};
  const input=data();input.candidates=[base,cheap,{...base,rank:11,estimated_usd:0},{...base,available:false,estimated_usd:0}];
  assert.equal(routeVideoModel(input).model.endpoint_id,cheap.endpoint_id);
  input.mode='best_quality';assert.equal(routeVideoModel(input).model.endpoint_id,base.endpoint_id);
  input.mode='within_budget';input.budget_usd=.10;assert.throws(()=>routeVideoModel(input),/Top 10/);
  input.mode='manual';input.manual_endpoint_id=cheap.endpoint_id;input.requires_native_audio=true;assert.throws(()=>routeVideoModel(input));
  input.requires_native_audio=false;input.resolution='1080p';assert.throws(()=>routeVideoModel(input));
  input.resolution='720p';input.index=1;assert.throws(()=>routeVideoModel(input));
  input.index=0;input.edited_seconds=11;assert.throws(()=>routeVideoModel(input));
});
test('compiled prompt uses cited endpoint conventions and preserves intended motion/identity',async()=>{
  const kling={...base,endpoint_id:'mock/shot-family',input_schema:{properties:{...base.input_schema.properties,multi_prompt:{type:'array',description:'Multiple shots or a single prompt.'}}}};
  for(const m of [base,kling])await ensureVideoKnowledge(db,m,{read:async()=>page(m)});
  const a=await directVideoScene(db,data()),b=await directVideoScene(db,{...data(),candidates:[kling]});
  assert.equal(a.inspection.passed,true);assert.equal(a.generation_seconds,6);assert.equal(a.edited_seconds,5);
  assert.equal(b.prompt_format,'opening-first');assert.notEqual(a.prompt,b.prompt);assert.ok(b.knowledge_sources.length);
  assert.match(a.prompt,/blue jacket/);assert.ok(a.prompt.includes(scene.visual_prompt));assert.match(a.prompt,/hold the final composition/);
});
test('backward causal dependencies are repaired in one bounded pass; original prompts remain byte exact',async()=>{
  const input=data();input.scene.direction.actions.reverse();
  const a=await directVideoScene(db,input);assert.equal(a.inspection.passed,true);assert.equal(a.inspection.revisions,1);
  assert.ok(a.prompt.indexOf('The courier bumps the barrier.')<a.prompt.indexOf('The wallet falls to the floor.'));
  const original='  Different version, the wallet falls.  ';
  const b=await directVideoScene(db,{...input,prompt_mode:'original',original_prompt:original});
  assert.equal(b.prompt,original);assert.equal(b.inspection.passed,false);assert.equal(b.inspection.revisions,0);
});
test('unresolved physics/causal, state and intent contradictions block a prompt, including manual edits',async()=>{
  const input=data(),actions=input.scene.direction.actions;
  actions[0].after=['drop'];assert.equal((await directVideoScene(db,input)).inspection.passed,false);
  actions[0].after=[];actions[1].action='C1 deliberately places the wallet.';assert.equal((await directVideoScene(db,input)).inspection.passed,false);
  actions[1].action='The wallet falls.';const custom=await directVideoScene(db,{...input,prompt_mode:'original',original_prompt:'He deliberately places the wallet on the ground.'});assert.equal(custom.inspection.passed,false);
  actions[0].object_id='P1';actions[0].from_state='in hand';actions[0].to_state='airborne';
  actions[1].object_id='P1';actions[1].from_state='in pocket';actions[1].to_state='on floor';
  assert.ok((await directVideoScene(db,input)).inspection.issues.some(s=>s.includes('ขาดความต่อเนื่อง')));
});
test('schema-only docs expose actual capability evidence without inventing a prompting guide',()=>{
  const profile=buildKnowledge(base,null);assert.equal(profile.documented,false);
  assert.ok(profile.documents.every(d=>d.source===base.source_url));assert.ok(!profile.documents.some(d=>d.tag==='negative_prompt'));
});

test('model guide uses one OpenAI search per revision, filters unofficial URLs, records usage and preserves immutable evidence',async()=>{
  const {researchModelGuide,currentModelGuide}=await import('./video-director-guides.js');
  const m={...base,endpoint_id:'fal-ai/kling-video/v3/mock-guide'},k=await ensureVideoKnowledge(db,m,{read:async()=>page(m)});
  const source='https://klingai.com/docs/mock-guide',spam='https://unrelated.example/third-party-page';
  const findings=[source,spam].map(url=>({category:'camera',url,quote:'Describe the opening frame and a single camera movement.',advice:'Lead with framing and a single move.'}));
  let posts=0,gets=0;
  const options={key:'test-only',response:async(_body:any,options:any)=>{
    if(!options.responseId){posts++;return {id:'resp_test',status:'queued'};}
    gets++;
    return {id:'resp_test',status:'completed',usage:{input_tokens:321},output:[
      ...[source,spam].map(url=>({type:'web_search_call',status:'completed',action:{type:'open_page',url}})),
      {type:'message',content:[{type:'output_text',text:JSON.stringify({endpoint_id:m.endpoint_id,findings})}]}]};
  },verify:async(_db:any,_id:string,_response:any,citations:any[])=>({sources:citations,evidence:citations.map(c=>({url:c.url,claim:c.claim,method:'openai_page' as const,checked_at:new Date().toISOString()}))})};
  await Promise.all([researchModelGuide(db,m,k,options),researchModelGuide(db,m,k,options)]);
  const profile=await currentModelGuide(db,k);
  assert.equal(posts,1);assert.equal(gets,1);assert.notEqual(profile.version,k.version);
  assert.ok(profile.documents.some(p=>p.source===source));assert.ok(!profile.documents.some(p=>p.source===spam));
  assert.deepEqual((await db.query<any>('SELECT usage FROM video_model_guide_research WHERE endpoint_id=$1',[m.endpoint_id])).rows[0].usage,{input_tokens:321});
  await researchModelGuide(db,m,k,options);assert.equal(posts,1);
});
test('causal continuity checks honor motivated changes of setting and prop state',async()=>{
  const input=data(),previous=structuredClone(input.scene.direction);
  previous.closing_object_states={P1:'on floor'};input.scene.direction.opening_object_states={P1:'in hand'};
  input.previous_direction=previous;assert.ok((await directVideoScene(db,input)).inspection.issues.some(s=>s.includes('ฉากก่อน')));
  input.scene.direction.motivated_transition='Show the courier picking up the wallet at the cut.';
  assert.equal((await directVideoScene(db,input)).inspection.passed,true);
});

test('native speech preserves exact Thai narration and blocks an explicitly translating endpoint',async()=>{
  const m={...base,endpoint_id:'mock/translated-audio',audio:true,input_schema:{properties:{...base.input_schema.properties,
    generate_audio:{type:'boolean',description:'Other languages are automatically translated to English.'}}}};
  await ensureVideoKnowledge(db,m,{read:async()=>page(m)});
  const input={...data(),candidates:[m],requires_native_audio:true};
  const generated=await directVideoScene(db,input);assert.ok(generated.prompt.includes(scene.narration));assert.equal(generated.inspection.passed,false);
  const manual=await directVideoScene(db,{...input,prompt_mode:'original'});assert.ok(manual.inspection.issues.some(s=>s.includes('บทภาษาไทย')));
});
test('router applies actual local inspection history to close model decisions',()=>{
  const second={...base,rank:2,endpoint_id:'mock/second'},input={...data(),candidates:[base,second],mode:'best_quality' as const};
  const routed=routeVideoModel(input,new Map([[base.endpoint_id,{sample:12,quality:35,failed:7,pattern:null}],[second.endpoint_id,{sample:12,quality:88,failed:0,pattern:null}]]));
  assert.equal(routed.model.endpoint_id,second.endpoint_id);
});

test('external image guidance is distinct from continuity references to the previous shot',async()=>{
  const imageModel={...base,category:'image-to-video',endpoint_id:'mock/first-frame',input_schema:{properties:{...base.input_schema.properties,image_url:{type:'string',description:'First frame'}}}};
  await ensureVideoKnowledge(db,imageModel,{read:async()=>page(imageModel)});
  const input={...data(),index:1,previous_end_frame:'An earlier train in another town.',candidates:[imageModel]};
  const explicit=await directVideoScene(db,{...input,has_explicit_reference:true});
  assert.match(explicit.prompt,/supplied reference image/);assert.ok(!explicit.prompt.includes(input.previous_end_frame));
  assert.ok((await directVideoScene(db,input)).prompt.includes(input.previous_end_frame));
});

test('ambient audio support alone cannot displace required Thai voiceover',async()=>{
  const m={...base,endpoint_id:'mock/ambient',audio:true,input_schema:{properties:{...base.input_schema.properties,generate_audio:{type:'boolean',description:'Native environmental sound effects.'}}}};
  await ensureVideoKnowledge(db,m,{read:async()=>page(m)});
  const directed=await directVideoScene(db,{...data(),candidates:[m],requires_native_audio:true});
  assert.ok(directed.inspection.issues.some(s=>s.includes('เสียงพูดตามบท')));
});

test('director retrieves compact eligible guide context; compiler binds LLM-crafted scene cues to the selected endpoint and its exact revision',async()=>{
  const {directorKnowledgeContext}=await import('./video-director.js');
  await db.exec('CREATE TABLE video_arena_snapshots (models jsonb)');
  assert.deepEqual(await directorKnowledgeContext(db,'รถไฟ'),[]);
  const knowledge=await ensureVideoKnowledge(db,base,{read:async()=>page(base)});
  await db.query('INSERT INTO video_arena_snapshots VALUES ($1)',[JSON.stringify([{rank:1,fal:base},{rank:11,fal:{...base,endpoint_id:'other'}}])]);
  const [entry]=await directorKnowledgeContext(db,'A courier in a train station','a close camera');
  assert.equal(entry.endpoint_id,base.endpoint_id);assert.equal(entry.knowledge_version,knowledge.version);assert.ok(entry.evidence.length>0);
  const input=data(),cue='Pan with the courier until the wallet falls beneath the barrier.';
  input.scene.direction.model_cues=[{endpoint_id:base.endpoint_id,knowledge_version:entry.knowledge_version,evidence_tag:entry.evidence[0].tag,cue}];
  assert.ok((await directVideoScene(db,input)).prompt.includes(cue));
  input.scene.direction.model_cues[0].knowledge_version='f'.repeat(64);
  assert.ok(!(await directVideoScene(db,input)).prompt.includes(cue));
});
