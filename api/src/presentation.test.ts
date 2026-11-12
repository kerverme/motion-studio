import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Graphic,withPresentationPolicy,presentationSceneProblems} from './presentation.js';
import {Storyboard,reviseStoryboard} from './storyboard.js';
import {emptyArtwork,updateArtwork,reconcileArtwork} from './art-batches.js';
import {Draft,sceneCode,systemPrompt} from './studio.js';

const code='def draw(c,t,p):\n  c.circle(540+t*5,1150,100,"teal")';
const plan=()=>Storyboard.parse({story_mode:'general',presentation_version:1,script:['open','example','facts','end'].map((id,i)=>({id,text:'ตัวอย่างการเล่าเรื่องด้วยภาพและสิ่งของ',beat:i===0?'hook':i===3?'cta':'info'})),
  shots:['hook','illustration','list','outro'].map((layout,i)=>({seg:['open','example','facts','end'][i],layout,visual:'Draw the actual topic objects and a large readable graphic',action:'The object moves and the evidence appears',camera:'A clear view of the narrated example',characters:[]})),character_notes:'Objects only; no forced mascot or named narrator.'});
const scenes=()=>[
  {seg:'open',type:'custom',code,graphic:{type:'hook',lines:[{text:'เกิดอะไรขึ้น?'}]}},
  {seg:'example',type:'custom',code,headline:{text:'ดูตัวอย่างนี้'},graphic:{type:'illustration'}},
  {seg:'facts',type:'custom',code,headline:{text:'ดูทีละข้อ'},graphic:{type:'list',items:[{text:'วัตถุ',at:'ตัวอย่าง'},{text:'เหตุการณ์',at:'ภาพ'}]}},
  {seg:'end',type:'custom',code,graphic:{type:'outro',lines:[{text:'คุณคิดอย่างไร?',at:'ตัวอย่าง'}],icon_at:'ภาพ'}},
];

test('classic plan rejects missing or monotonous layouts but legacy checkpoints stay valid',()=>{
  const p=plan();assert.equal(Storyboard.safeParse({...p,shots:p.shots.map(s=>({...s,layout:undefined}))}).success,false);
  assert.equal(Storyboard.safeParse({...p,shots:p.shots.map(s=>({...s,layout:'illustration'}))}).success,false);
  assert.equal(Storyboard.safeParse({...p,presentation_version:undefined,shots:p.shots.map(s=>({...s,layout:undefined}))}).success,true);
  assert.equal(withPresentationPolicy({...p,presentation_version:0},1).presentation_version,1);
  assert.equal(withPresentationPolicy(p,0).presentation_version,undefined);
});

test('drawings require their planned real graphics, readable headings and valid values',()=>{
  const p=plan(),s=scenes();let state=emptyArtwork();
  for(const scene of s)state=updateArtwork(state,'draw_scene',{scene},p);
  assert.equal(state.scenes.length,4);
  assert.throws(()=>updateArtwork(state,'draw_scene',{scene:{...s[2],graphic:{type:'illustration'}}},p),/match the saved layout/);
  assert.throws(()=>updateArtwork(state,'draw_scene',{scene:{...s[1],headline:undefined}},p),/headline/);
  assert.equal(Graphic.safeParse({type:'number',value:Infinity,at:'ข้อมูล',label:{text:'จำนวน',at:'ข้อมูล'}}).success,false);
  assert.equal(Graphic.safeParse({type:'list',items:[]}).success,false);
  assert.deepEqual(presentationSceneProblems(p.shots[1],{type:'custom',code},false),[]);
});

test('changing one graphic layout only invalidates that scene; packages retain presentation',()=>{
  const p=plan();let state=emptyArtwork();for(const scene of scenes())state=updateArtwork(state,'draw_scene',{scene},p);
  const revised=reviseStoryboard(p,{segments:[{seg:'facts',layout:'chat'}]});
  assert.deepEqual(reconcileArtwork(p,revised,state).scenes.map(s=>s.seg),['open','example','end']);
  const d=Draft.parse({story_mode:'general',storyboard:p,title_th:'เรื่องตัวอย่าง',script:p.script,scenes:scenes(),sources:[{url:'https://example.org',publisher:'test',published:'2026',claim:'test'}],claims:[{text:'ตัวอย่าง',kind:'assumption',source_ids:[]}],captions:{facebook:'',instagram:'',tiktok:'',youtube:'',twitter:''}});
  const match=sceneCode(d).match(/SPEC = json\.loads\((.*)\)\nSCENES/)!;const spec=JSON.parse(JSON.parse(match[1]));
  assert.equal(spec.presentation_version,1);assert.deepEqual(spec.scenes.map((s:any)=>s.graphic),scenes().map(s=>s.graphic));assert.deepEqual(spec.cast,[]);
  const prompt=systemPrompt({fc:false,ws:true},'general',1,1);
  assert.match(prompt,/EP004/);assert.match(prompt,/Kanit/);assert.doesNotMatch(prompt,/No fixed scene layouts or preset sets/);assert.doesNotMatch(prompt,/headline from t=0 with c.text/);
});
