import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Storyboard,withDepictionPolicy,reviseStoryboard,validateStoryboardDraft} from './storyboard.js';
import {emptyArtwork,updateArtwork,artworkComplete,reconcileArtwork,mergeArtwork} from './art-batches.js';
import {directionPrompt} from './direction.js';

function plan(){return Storyboard.parse(withDepictionPolicy({story_mode:'general',script:['classroom','car','brain','garden'].map((id,i)=>({id,text:'เรื่องสมมติ อธิบายความง่วง ด้วยตัวอย่างในชีวิตประจำวัน',beat:i===0?'hook':i===3?'cta':'info'})),shots:[
  {seg:'classroom',visual:'A sleepy pupil sits beside a desk in a classroom',action:'The pupil yawns and puts down a pencil',camera:'Medium view of the classroom desk',characters:['พีท'],subjects:[{id:'pupil',description:'นักเรียนง่วงนั่งอยู่ข้างโต๊ะเรียน'},{id:'desk',description:'โต๊ะเรียนและสมุดที่กำลังใช้งาน'}]},
  {seg:'car',visual:'A different fictional driver stops a car safely',action:'The driver stops and rests before continuing',camera:'Side view of the driver and parked car',characters:['นัท'],subjects:[{id:'driver',description:'ผู้ขับรถสมมติที่กำลังพักเพราะง่วง'},{id:'car',description:'รถยนต์จอดสนิทอย่างปลอดภัยข้างทาง'}]},
  {seg:'brain',visual:'A character-free diagram explains a process in the brain',action:'Signals move through the explanatory diagram',camera:'Close view of the explanatory diagram',characters:[],subjects:[{id:'diagram',description:'แผนภาพสมองพร้อมลูกศรอธิบายกระบวนการ'}]},
  {seg:'garden',visual:'The pupil is awake and active in a garden',action:'The same pupil puts the notebook on a garden bench',camera:'Wide view of the garden and pupil',characters:['พีท'],subjects:[{id:'pupil',description:'นักเรียนคนเดิมในสวนกำลังวางสมุด'}]},
],character_notes:'Characters suit each example; there is no compulsory cat or presenter.'},true));}

function complete(){const p=plan();let state=emptyArtwork();for(const name of ['พีท','นัท'])state=updateArtwork(state,'draw_character',{character:{name,portrait_code:'def draw(c,t,p):\n    c.circle(0,0,70,"tan")',portrait_description:'A fictional character appropriate to this example'}},p);
  for(const shot of p.shots)state=updateArtwork(state,'draw_scene',{scene:{seg:shot.seg,type:'custom',code:'def draw(c,t,p):\n    c.rect(300,700,300,300,"teal")\n'+shot.characters.map(name=>`    c.person("${name}",540,700,200)`).join('\n'),depicted_subjects:shot.subjects!.map(s=>s.id)}},p);
  return {p,state};}

test('context stories require concrete example subjects but allow different locations, cast and character-free shots',()=>{
  const p=plan();assert.equal(p.depiction_version,1);assert.equal(p.shots[2].characters.length,0);assert.equal(p.recurring_character,undefined);
  const missing=structuredClone(p);delete missing.shots[1].subjects;assert.equal(Storyboard.safeParse(missing).success,false);
  const duplicate=structuredClone(p);duplicate.shots[1].subjects!.push(duplicate.shots[1].subjects![0]);assert.equal(Storyboard.safeParse(duplicate).success,false);
  const legacy=withDepictionPolicy(missing,false);assert.equal(legacy.depiction_version,undefined);assert.equal(Storyboard.safeParse(legacy).success,true);
  const prompt=directionPrompt();assert.match(prompt,/varied scene changes/);assert.match(prompt,/sleepy driver belongs in a car/);assert.ok(!prompt.includes('Maintain a persistent setting, presenter'));
});

test('saved and final drawings must account for every planned example subject and preserve legacy compatibility',()=>{
  const {p,state}=complete();assert.equal(artworkComplete(state,p),true);const d={...mergeArtwork({script:p.script},state),storyboard:p,script:p.script,cast:state.cast,scenes:state.scenes};assert.deepEqual(validateStoryboardDraft(p,d),[]);
  const incomplete={...state.scenes[1],depicted_subjects:['driver']};assert.throws(()=>updateArtwork(state,'draw_scene',{scene:incomplete},p),/missing depicted subject car/);
  assert.ok(validateStoryboardDraft(p,{...d,scenes:d.scenes.map(s=>s.seg==='car'?incomplete:s)}).some(e=>e.startsWith('storyboard car: missing depicted subject car')));
  assert.throws(()=>updateArtwork(state,'draw_scene',{scene:{...incomplete,depicted_subjects:['driver','car','unknown']}},p),/not in the saved shot/);
  assert.throws(()=>updateArtwork(state,'draw_scene',{scene:{...incomplete,depicted_subjects:['driver','car','car']}},p),/duplicates/);
  const {depicted_subjects,...untracked}=state.scenes[1];assert.throws(()=>updateArtwork(state,'draw_scene',{scene:untracked},p),/provide depicted_subjects/);
  assert.doesNotThrow(()=>updateArtwork({...state,scenes:[]},'draw_scene',{scene:untracked},Storyboard.parse(withDepictionPolicy(p,false))));
});

test('changing an example drops only its drawing and preserves narration, portraits and unrelated checkpoints',()=>{
  const {p,state}=complete();const next=reviseStoryboard(p,{segments:[{seg:'car',subjects:[...p.shots[1].subjects!,{id:'rest_area',description:'จุดพักรถข้างทางที่รถจอดอย่างปลอดภัย'}]}]});
  const retained=reconcileArtwork(p,next,state);assert.deepEqual(retained.scenes.map(s=>s.seg),['classroom','brain','garden']);assert.deepEqual(retained.cast,state.cast);assert.deepEqual(next.script,p.script);
  const upgraded=reconcileArtwork(Storyboard.parse(withDepictionPolicy(p,false)),p,state);assert.equal(upgraded.scenes.length,0);assert.deepEqual(upgraded.cast,state.cast);
});
