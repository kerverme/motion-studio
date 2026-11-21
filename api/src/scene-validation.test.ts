import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGraph,sceneGate} from './scene-logic.js';

function fixture(){
 const evidence={frames:[0,.9,1.1,1.9].map((at_s,frame)=>({frame,at_s,asset_id:'frame-'+frame}))};
 const refs=(...indices:number[])=>indices.map(index=>({frame_index:index,at_s:evidence.frames[index].at_s,observation:'Measured visual evidence'}));
 const document={characters:[{id:'C1'}],shots:[{id:'S1',start_s:0,end_s:2,actions:[{t0:0,t1:1,text:'[C1] accidentally drops the cup.'},{t0:1,t1:2,text:'[C1] reacts to the falling cup.'}]}]};
 const graph:any={summary:'Drop then reaction',events:[
  {id:'E1',shot_id:'S1',start_s:0,end_s:1,actor_ids:['C1'],object_ids:['O1'],action:'[C1] accidentally drops the cup.',mode:'accidental',basis:'observed',source_action_indices:[0],evidence:refs(0,1),uncertainty:''},
  {id:'E2',shot_id:'S1',start_s:1,end_s:2,actor_ids:['C1'],object_ids:['O1'],action:'[C1] reacts to the falling cup.',mode:'reaction',basis:'observed',source_action_indices:[1],evidence:refs(2,3),uncertainty:''}
 ],dependencies:[{from:'E1',to:'E2',relation:'causes',basis:'observed',explanation:'The drop precedes the reaction.'}],spatial:[{event_id:'E1',character_id:'C1',position:'beside cup',orientation:'front',gaze:'cup',field_of_view:'approximate',distance:'near',visible_objects:['O1'],occlusions:[],knowledge:'Cup is visible',basis:'observed',uncertainty:''}],objects:[{id:'O1',description:'cup',states:[{event_id:'E1',owner_id:'C1',placement:'falling from hand',visibility:'visible',basis:'observed',uncertainty:''}]}],issues:[]};
 const issue=()=>({id:'I1',type:'source_fidelity',severity:'critical',shot_id:'S1',event_ids:['E1'],evidence:refs(0,1),explanation:'Remake turns accidental drop into deliberate placement.',suggested_correction:'Preserve accidental release.',confidence:.95,basis:'observed',uncertainty:''});
 return {graph,document,evidence,refs,issue};
}

test('normalization preserves grounding without mutating the saved graph',()=>{
 const {graph,document,evidence}=fixture(),before=structuredClone(graph);
 const result=validateGraph(graph,document,evidence);
 assert.deepEqual(graph,before);assert.equal(result.events[0].basis,'observed');
 assert.match(result.spatial[0].uncertainty,/approximate/);
 assert.deepEqual(validateGraph(result,document,evidence),result);
});

for(const caseName of ['empty','single','duplicated','same asset','same time','outside event'] as const){
 test(`observed event becomes inferred with ${caseName} evidence`,()=>{
  const {graph,document,evidence,refs,issue}=fixture();graph.issues=[issue()];
  if(caseName==='empty')graph.events[0].evidence=[];
  if(caseName==='single')graph.events[0].evidence=refs(0);
  if(caseName==='duplicated')graph.events[0].evidence=refs(0,0);
  if(caseName==='same asset')evidence.frames[1].asset_id=evidence.frames[0].asset_id;
  if(caseName==='same time'){
   evidence.frames[1].at_s=evidence.frames[0].at_s;
   graph.events[0].evidence=refs(0,1);graph.issues[0].evidence=refs(0,1);
  }
  if(caseName==='outside event')graph.events[0].evidence=refs(2,3);
  const result=validateGraph(graph,document,evidence);
  assert.equal(result.events[0].basis,'inferred');assert.equal(result.dependencies[0].basis,'inferred');
  assert.equal(result.spatial[0].basis,'inferred');assert.equal(result.issues[0].basis,'inferred');
  assert.equal(result.objects[0].states[0].basis,'inferred');
  assert.equal(sceneGate({graph:result,review:{}}).status,'warning');
 });
}

test('an observed issue needs its own temporal support for every referenced event',()=>{
 for(const citations of [[],[0],[0,0],[2,3]]){
  const {graph,document,evidence,refs,issue}=fixture();graph.issues=[{...issue(),evidence:refs(...citations)}];
  const result=validateGraph(graph,document,evidence);
  assert.equal(result.events[0].basis,'observed');assert.equal(result.issues[0].basis,'inferred');
  assert.equal(sceneGate({graph:result,review:{}}).status,'warning');
 }
 const {graph,document,evidence,issue}=fixture();graph.issues=[{...issue(),event_ids:['E1','E2']}];
 assert.equal(validateGraph(graph,document,evidence).issues[0].basis,'inferred');
});

test('grounded critical contradiction blocks and owner review is explicit',()=>{
 const {graph,document,evidence,issue}=fixture();graph.issues=[issue()];
 const result=validateGraph(graph,document,evidence);
 assert.equal(sceneGate({graph:result,review:{}}).status,'blocked');
 assert.equal(sceneGate({graph:result,review:{dismissed_issue_ids:['I1']}}).status,'passed');
 result.issues[0].basis='inferred';
 assert.equal(sceneGate({graph:result,review:{confirmed_issue_ids:['I1']}}).status,'blocked');
 assert.equal(sceneGate({graph:result,review:{requires_revalidation:true,dismissed_issue_ids:['I1']}}).status,'blocked');
});

for(const field of ['dependency','spatial','object'] as const){
 test(`gate does not claim passed when ${field} facts are uncertain`,()=>{
  const {graph}=fixture();
  if(field==='dependency')graph.dependencies[0].basis='inferred';
  if(field==='spatial')graph.spatial[0].basis='unknown';
  if(field==='object')graph.objects[0].states[0].basis='unknown';
  assert.equal(sceneGate({graph,review:{}}).status,'warning');
 });
}

test('source action bindings prevent omission and retiming within a shot',()=>{
 const {graph,document,evidence}=fixture();graph.events[0].end_s=1.4;
 assert.throws(()=>validateGraph(graph,document,evidence),/locked source actions/);
 graph.events[0].end_s=1;graph.events.pop();
 assert.throws(()=>validateGraph(graph,document,evidence),/omitted source actions/);
});

test('unknown, mismatched, non-finite and blank evidence fail validation',()=>{
 for(const mutate of [(ref:any)=>ref.frame_index=999,(ref:any)=>ref.at_s+=.001,(ref:any)=>ref.at_s=NaN,(ref:any)=>ref.observation='   ']){
  const {graph,document,evidence}=fixture();mutate(graph.events[0].evidence[0]);
  assert.throws(()=>validateGraph(graph,document,evidence));
 }
});

test('duplicate IDs, empty events/actions and graph size limits are enforced',()=>{
 const mutations=[
  (graph:any)=>graph.events[1].id=graph.events[0].id,
  (graph:any)=>graph.events[0].id=' ',
  (graph:any)=>graph.events[0].action=' ',
  (graph:any)=>graph.events=[],
  (graph:any)=>graph.events=Array.from({length:301},(_,i)=>({...graph.events[0],id:'E'+i})),
  (graph:any)=>graph.objects.push(structuredClone(graph.objects[0])),
 ];
 for(const mutate of mutations){const {graph,document,evidence}=fixture();mutate(graph);assert.throws(()=>validateGraph(graph,document,evidence));}
 const {graph,document,evidence,issue}=fixture();graph.issues=Array.from({length:201},(_,i)=>({...issue(),id:'I'+i}));
 assert.throws(()=>validateGraph(graph,document,evidence),/size/);
});

test('causal cycles, reversed time and invalid ownership references are rejected',()=>{
 const {graph,document,evidence}=fixture();graph.dependencies=[{...graph.dependencies[0],from:'E2',to:'E1'}];
 assert.throws(()=>validateGraph(graph,document,evidence),/reverses source time/);
 graph.dependencies=[];graph.objects[0].states[0].owner_id='C_missing';
 assert.throws(()=>validateGraph(graph,document,evidence),/continuity reference/);
 graph.objects[0].states[0].owner_id='C1';
 document.shots[0].actions[1].t0=0;document.shots[0].actions[1].t1=1;
 graph.events[1].start_s=0;graph.events[1].end_s=1;
 graph.dependencies=[{from:'E1',to:'E2',relation:'before',basis:'inferred',explanation:''},{from:'E2',to:'E1',relation:'before',basis:'inferred',explanation:''}];
 assert.throws(()=>validateGraph(graph,document,evidence),/cycle/);
});

test('known location IDs in visibility preserve real objects and downgrade the observation',()=>{
 const {graph,document,evidence}=fixture(),doc={...document,locations:[{id:'L1'},{id:'L2'},{id:'L3'}]};
 graph.spatial[0].visible_objects=['L1','O1','L2','C1','L3'];
 const normalized=validateGraph(graph,doc,evidence);
 assert.deepEqual(normalized.spatial[0].visible_objects,['O1']);assert.equal(normalized.spatial[0].basis,'unknown');
 assert.match(normalized.spatial[0].uncertainty,/L1, L2, C1, L3/);
 assert.deepEqual(validateGraph(normalized,doc,evidence),normalized);
 graph.spatial[0].visible_objects=['missing'];assert.throws(()=>validateGraph(graph,doc,evidence),/ไม่มีในหลักฐาน/);
});
