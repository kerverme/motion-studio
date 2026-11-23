import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Hono} from 'hono';
import {CreativeSettings,chooseStyle} from './creative.js';
import {Storyboard} from './storyboard.js';
import {Draft,registerStudio,creativePackageProblems} from './studio.js';
const sample=JSON.parse(readFileSync(new URL('../../lemo-worker/tests/fixtures/nik.json',import.meta.url),'utf8'));
function fixture(){
  const script=[{id:'hook',beat:'hook',text:'ทำไมแก้วใบนี้ ย้ายแล้วเงาเปลี่ยน'},...['water','light','routine'].map(id=>({id,beat:'rehook',text:'ลองดูแก้วใบเดิม เราเลื่อนแก้ว แล้วเลื่อนแก้วอีกครั้ง ให้แสงผ่านไปยังโต๊ะ ตัวอย่างนี้ช่วยให้เราเห็น ว่าตำแหน่งของสิ่งของ ทำให้ภาพที่เห็นต่างออกไป เราจะลองทีละอย่าง แล้วสังเกตผลที่เกิดขึ้น เพื่อหาคำตอบจากสิ่งตรงหน้า'})),{id:'end',beat:'cta',text:'ตอนนี้เงาเปลี่ยนตามแก้วแล้ว คุณอยากลองย้ายอะไร เล่าในคอมเมนต์ให้ฟังหน่อย'}];
  const plan=structuredClone(sample.creative);
  plan.scenes=script.map(s=>({...structuredClone(sample.creative.scenes[0]),seg:s.id,sound:{decision:['hook','end'].includes(s.id)?'silence':'effects',reason:'Visible glass moves across the table',cues:['hook','end'].includes(s.id)?[]:[0,1].map(n=>({id:'glass'+n,word:'เลื่อนแก้ว',occurrence:n,offset:0,action:'Make the moving glass audible on the table',prompt:'Glass moving over '+s.id+' surface',duration:1,gain:.2}))}}));
  const storyboard=Storyboard.parse({story_mode:'general',direction_version:1,narrative:{premise:'A glass makes an unexpected shadow on one table',central_question:'Why does moving this glass change its shadow?',throughline:'Move the same glass, observe sunlight and compare the outcome',payoff:'The changed position explains the new shadow on the same table'},sound_policy:{mode:'designed'},creative:plan,script,shots:script.map(s=>({seg:s.id,visual:'The same glass on the same table next to one window',action:'Move the glass and follow its changing shadow',camera:'Medium view of the same tabletop',characters:[],continuity:{from:'The glass rests where the previous shot left it',to:'The glass and shadow remain at their demonstrated position'},motion_beats:[{start:0,end:.5,action:'Move the glass across the tabletop',purpose:'Show the attempted change in position'},{start:.5,end:1,action:'Follow the changed shadow while the glass settles',purpose:'Make the causal result visible before the next shot'}]})),character_notes:'No people; the same glass and table persist throughout.'});
  const cues=['water','light','routine'].flatMap((seg,i)=>[0,1].map(n=>({sfx:['tick','ding','whoosh'][i],seg,at:'เลื่อนแก้ว',n,gain:.35,purpose:'Make the visible glass movement audible'})));
  const draft=Draft.parse({story_mode:'general',storyboard,script,title_th:'แก้วใบเดิม เงาที่เปลี่ยนไป',format:'mystery',cast:[],scenes:script.map(s=>({seg:s.id,type:'custom',code:'def draw(c,t,p):\n  c.grad("sky","cream")\n  c.rect(300+t*20,600,240,360,"teal")'})),art:'',sfx:cues,motion_review:'water and light move the same glass across the table; a short hold lets the changed shadow remain readable before routine repeats the experiment.',sources:[{url:'https://example.org/light',publisher:'Example',published:String(new Date().getUTCFullYear()),claim:'Light and shadow context'}],claims:[{text:'เหตุการณ์แก้วใบนี้เป็นตัวอย่างสมมติ',kind:'assumption',source_ids:[]}],captions:{facebook:'แก้วใบเดิม',instagram:'แก้วใบเดิม',tiktok:'แก้วใบเดิม',youtube:'แก้วใบเดิม',twitter:'แก้วใบเดิม'}});
  const settings=CreativeSettings.parse({engine:'classic'});
  return {id:'a5000000-0000-0000-0000-000000000001',topic:draft.title_th,status:'ready',draft,storyboard,characters:[],note:'',creative:{engine:'classic',settings,selection:chooseStyle(plan,settings,script)}};
}
function appFor(row:any,validate:(p:any)=>string[]=()=>[],estimate:(p:any)=>number=()=>100){
  const pool={query:async(sql:string)=>({rows:sql.startsWith('SELECT * FROM drafts WHERE id=$1')?[row]:[],rowCount:0})};
  const nativeTimeout=globalThis.setTimeout;
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  const app=new Hono();
  try{registerStudio(app,pool as any,{guard:async(_c,n)=>n(),createJob:async()=>{throw Error('No job creation in estimate test');},estimateCredits:estimate,validate,researchFreshness:()=>[]});}finally{globalThis.setTimeout=nativeTimeout;}
  return app;
}
const estimate=(app:Hono,id:string)=>app.request('/app/api/creative/'+id+'/estimate');
test('Classic quote validates actual replacement sounds before any job exists',async()=>{
  const row=fixture(),seen:any[]=[];
  const app=appFor(row,p=>{seen.push(structuredClone(p));return p.sfx.some((s:any)=>s.model_id==='eleven_text_to_sound_v3')?['Final audio contract rejected']:[];});
  const res=await estimate(app,row.id);assert.equal(res.status,422);assert.match((await res.json()).error,/Final audio contract rejected/);
  assert.ok(seen.some(p=>p.sfx.length===6 && p.sfx.every((s:any)=>s.model_id==='eleven_text_to_sound_v3')));
  assert.ok(seen.some(p=>p.sfx.every((s:any)=>!s.model_id)),'legacy package validation is insufficient');
});
test('low-volume foley remains valid; actual missing cues cannot hide behind legacy metadata',async()=>{
  const row=fixture(),app=appFor(row);assert.equal((await estimate(app,row.id)).status,200);
  for(const scene of row.storyboard.creative!.scenes)scene.sound.cues=scene.sound.cues.slice(0,1);
  row.draft.storyboard=row.storyboard;
  const res=await estimate(app,row.id);assert.equal(res.status,422);assert.match((await res.json()).error,/6 distinct/);
  assert.equal(row.draft.sfx.length,6,'legacy metadata still contains six effects');
});
test('creative credit limit is rechecked after replacing audio contract',async()=>{
  const row=fixture(),app=appFor(row,()=>[],p=>p.sfx.some((s:any)=>s.model_id)?5000:100);
  const res=await estimate(app,row.id);assert.equal(res.status,422);assert.match((await res.json()).error,/production audio exceeds/);
});
test('actual package detects invalid occurrence, duplicate padding, coverage and forged quiet',()=>{
  const row=fixture(),pkg={script:row.storyboard.script,sfx:row.storyboard.creative!.scenes.flatMap(s=>s.sound.cues.map(c=>({id:s.seg+c.id,prompt:c.prompt,purpose:c.action,cues:[{seg:s.seg,word:c.word,n:c.occurrence,offset:c.offset,gain:c.gain}]})))};
  assert.deepEqual(creativePackageProblems(pkg,row.storyboard),[]);
  const bad=structuredClone(pkg);bad.sfx[0].cues[0].n=2;assert.match(creativePackageProblems(bad,row.storyboard).join(';'),/anchor\/occurrence/);
  const padded={...pkg,sfx:Array.from({length:6},(_,i)=>({...pkg.sfx[0],id:'padded'+i}))};
  assert.match(creativePackageProblems(padded,row.storyboard).join(';'),/6 distinct/);
  assert.match(creativePackageProblems(padded,row.storyboard).join(';'),/half/);
  const quiet={...row.storyboard,sound_policy:{mode:'quiet' as const,owner_quote:'No SFX'}};
  assert.match(creativePackageProblems({...pkg,sfx:[]},quiet).join(';'),/exact owner_quote/);
  assert.deepEqual(creativePackageProblems({...pkg,sfx:[]},quiet,'No SFX'),[]);
  assert.deepEqual(creativePackageProblems({...pkg,sfx:[]},{...row.storyboard,direction_version:undefined}),[]);
});
