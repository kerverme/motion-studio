import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {directionProblems,directionPrompt,soundPolicy,withDirectionPolicy} from './direction.js';
import {Storyboard} from './storyboard.js';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio,Draft,checkDraft,buildPackage,systemPrompt}=await import('./studio.js');
const db=new PGlite();after(()=>db.close());
function directedDraft(){
  const script=[{id:'hook',beat:'hook',text:'ทำไมแก้วใบนี้ ย้ายแล้วเงาเปลี่ยน'},...['water','light','routine'].map(id=>({id,beat:'rehook',text:'ลองดูแก้วใบเดิม เราเลื่อนแก้ว แล้วเลื่อนแก้วอีกครั้ง ให้แสงผ่านไปยังโต๊ะ ตัวอย่างนี้ช่วยให้เราเห็น ว่าตำแหน่งของสิ่งของ ทำให้ภาพที่เห็นต่างออกไป เราจะลองทีละอย่าง แล้วสังเกตผลที่เกิดขึ้น เพื่อหาคำตอบจากสิ่งตรงหน้า'})),{id:'end',beat:'cta',text:'ตอนนี้เงาเปลี่ยนตามแก้วแล้ว คุณอยากลองย้ายอะไร เล่าในคอมเมนต์ให้ฟังหน่อย'}];
  const storyboard=Storyboard.parse({story_mode:'general',direction_version:1,narrative:{premise:'A glass makes an unexpected shadow on one table',central_question:'Why does moving this glass change its shadow?',throughline:'Move the same glass, observe sunlight and compare the outcome',payoff:'The changed position explains the new shadow on the same table'},sound_policy:{mode:'designed'},script,shots:script.map(s=>({seg:s.id,visual:'The same glass on the same table next to one window',action:'Move the glass and follow its changing shadow',camera:'Medium view of the same tabletop',characters:[],continuity:{from:'The glass rests where the previous shot left it',to:'The glass and shadow remain at their demonstrated position'},motion_beats:[{start:0,end:.5,action:'Move the glass across the tabletop',purpose:'Show the attempted change in position'},{start:.5,end:1,action:'Follow the changed shadow while the glass settles',purpose:'Make the causal result visible before the next shot'}]})),character_notes:'No people; the same glass and table persist throughout.'});
  const cues=['water','light','routine'].flatMap((seg,i)=>[{sfx:['tick','ding','whoosh'][i],seg,at:'เลื่อนแก้ว',n:0,offset:0,gain:.35,purpose:'Make the first visible glass movement audible'},{sfx:['ding','whoosh','tick'][i],seg,at:'เลื่อนแก้ว',n:1,offset:.25,gain:.4,purpose:'Mark the second glass movement and its consequence'}]);
  return Draft.parse({story_mode:'general',storyboard,script,title_th:'แก้วใบเดิม เงาที่เปลี่ยนไป',format:'mystery',cast:[],scenes:script.map(s=>({seg:s.id,type:'custom',code:'def draw(c,t,p):\n  c.grad("sky","cream")\n  c.rect(300+t*20,600,240,360,"teal")'})),art:'',sfx:cues,motion_review:'water and light move the same glass across the table; the short hold lets the changed shadow remain readable before routine repeats the experiment.',sources:[{url:'https://example.org/light',publisher:'Example',published:String(new Date().getUTCFullYear()),claim:'Light and shadow context'}],claims:[{text:'เหตุการณ์แก้วใบนี้เป็นตัวอย่างสมมติ',kind:'assumption',source_ids:[]}],captions:{facebook:'แก้วใบเดิม',instagram:'แก้วใบเดิม',tiktok:'แก้วใบเดิม',youtube:'แก้วใบเดิม',twitter:'แก้วใบเดิม'}});
}

test('quiet exception requires exact owner permission for silence or fewer effects, never simply lower volume',()=>{
  assert.deepEqual(soundPolicy(undefined),{mode:'designed'});
  for(const note of ['ไม่ต้องใส่ SFX ในคลิปนี้','No SFX please','Use fewer sound effects','ลดจำนวน SFX ลง'])assert.equal(soundPolicy({mode:'quiet',owner_quote:note},note).mode,'quiet');
  for(const note of ['เพิ่ม SFX ให้มากแต่เสียงเบา','More SFX but low volume','ไม่ต้องให้ SFX ดัง','ไม่ต้องลด SFX','Do not mute SFX','Read this article about quiet SFX'])assert.throws(()=>soundPolicy({mode:'quiet',owner_quote:note},note));
  assert.throws(()=>soundPolicy({mode:'quiet',owner_quote:'No SFX'},'Use lots of SFX'));
  assert.throws(()=>soundPolicy({mode:'quiet',owner_quote:'quiet'},'quiet'));
  assert.throws(()=>soundPolicy({mode:'quiet',owner_quote:'งด SFX'},'ไม่ต้องงด SFX'),'quote cannot discard the owner’s negation');
  assert.deepEqual(soundPolicy({mode:'designed'},'เพิ่ม SFX ให้มากแต่เสียงเบา'),{mode:'designed'});
});

test('directed contract validates sound density, diversity, timing occurrence, purpose and review while keeping legacy optional',()=>{
  const d=directedDraft();assert.deepEqual(directionProblems(d),[]);
  assert.ok(directionProblems({...d,sfx:[]}).some(p=>p.includes('at least 6')));
  assert.ok(directionProblems({...d,sfx:d.sfx.map(cue=>({...cue,sfx:'tick'}))}).some(p=>p.includes('3 distinct')));
  assert.ok(directionProblems({...d,sfx:d.sfx.map(cue=>({...cue,seg:'water'}))}).some(p=>p.includes('half')));
  assert.ok(directionProblems({...d,sfx:d.sfx.map(cue=>({...cue,purpose:''}))}).some(p=>p.includes('purpose')));
  assert.ok(directionProblems({...d,sfx:d.sfx.map(cue=>({...cue,gain:.8}))}).some(p=>p.includes('gain')));
  assert.ok(directionProblems({...d,sfx:d.sfx.map(cue=>({...cue,n:2}))}).some(p=>p.includes('occurrence')));
  assert.ok(directionProblems({...d,motion_review:undefined}).some(p=>p.includes('motion_review')));
  assert.deepEqual(directionProblems({...d,motion_review:undefined},'',true),[],'first submit must be able to receive previews');
  const quiet={...d,storyboard:{...d.storyboard!,sound_policy:{mode:'quiet' as const,owner_quote:'ไม่ต้องใส่ SFX'}},sfx:[]};
  assert.deepEqual(directionProblems(quiet,'ไม่ต้องใส่ SFX'),[]);assert.ok(directionProblems(quiet).length);
  const legacy={...d,storyboard:{...d.storyboard!,direction_version:undefined},sfx:[],motion_review:undefined};assert.deepEqual(directionProblems(legacy),[]);
  const raw={direction_version:1,shots:[]};assert.equal(withDirectionPolicy(raw,0).direction_version,undefined);assert.equal(raw.direction_version,1);
  assert.deepEqual(withDirectionPolicy({direction_version:0} as Record<string,any>,1).sound_policy,{mode:'designed'});
});

test('package preserves nth spoken cue and offset, exports direction review and does not force random scene changes',()=>{
  const d=directedDraft(),pkg=buildPackage('แก้วใบเดิม',d,[]);
  const cues=pkg.sfx.flatMap(group=>group.cues);
  assert.ok(cues.some(cue=>cue.seg==='water'&&cue.n===0&&cue.offset===0));
  assert.ok(cues.some(cue=>cue.seg==='water'&&cue.n===1&&cue.offset===.25));
  assert.equal(pkg.direction?.version,1);assert.equal(pkg.direction?.motion_review,d.motion_review);assert.deepEqual(pkg.direction?.shots[0].motion_beats,d.storyboard!.shots[0].motion_beats);
  assert.equal(buildPackage('legacy',{...d,storyboard:{...d.storyboard!,direction_version:undefined}},[]).direction,undefined);
  const prompt=systemPrompt({fc:false,ws:true},'general',1);assert.match(prompt,/one continuous causal story/);assert.match(prompt,/varied scene changes/);assert.match(prompt,/two strong sources can be enough/);
  for(const old of ['Vary bg between consecutive scenes','a fresh fact, number or twist every few seconds','Prefer 3–7 strong sources'])assert.ok(!prompt.includes(old));
  assert.match(directionPrompt(),/Mouth motion, bobbing/);assert.match(directionPrompt(),/8–12/);
  assert.ok(!checkDraft(d,null,[{format:'mystery',types:['custom'],title:'Another story'}]).problems.some(p=>p.includes('choose a different format')));
});

test('persisted director version protects legacy checkpoints, upgrades new work and rejects ready drafts that omit its contract',async()=>{
  const dir=new URL('../migrations/',import.meta.url),oldId='10000000-0000-0000-0000-000000000082',good=directedDraft();
  const legacyPlan={...good.storyboard!,direction_version:undefined};
  const oldArt={art:good.art,cast:good.cast,scenes:good.scenes};
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){
    if(file==='023_director_version.sql')await db.query("INSERT INTO drafts(id,topic,status,story_mode,storyboard,artwork) VALUES($1,'เรื่องเดิมยังวาดไม่จบ','failed','general',$2,$3)",[oldId,JSON.stringify(legacyPlan),JSON.stringify(oldArt)]);
    await db.exec(readFileSync(new URL(file,dir),'utf8'));
  }
  await db.exec(readFileSync(new URL('023_director_version.sql',dir),'utf8'));
  assert.equal((await db.query<{director_version:number}>('SELECT director_version FROM drafts WHERE id=$1',[oldId])).rows[0].director_version,0);
  const pool={query:async(sql:string,args:any[]=[])=>sql.startsWith("SELECT id FROM drafts WHERE status='queued'")?{rows:[]}:db.query(sql,args)};
  const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{
    let jobs=0;const app=new Hono();registerStudio(app,pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{jobs++;return{status:201,body:{}}},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    const path='/app/api/studio/drafts',send=(url:string,body:any,key:string,method='POST')=>app.request(url,{method,headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
    const retry=await send(path+'/'+oldId+'/rewrite',{},'old-direction-retry');assert.equal(retry.status,201);const retryId=(await retry.json()).id;
    const resumed:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[retryId])).rows[0];assert.equal(resumed.director_version,0);assert.deepEqual(resumed.storyboard,JSON.parse(JSON.stringify(legacyPlan)));assert.deepEqual(resumed.artwork,oldArt);
    await db.query("UPDATE drafts SET status='failed' WHERE id=$1",[retryId]);
    const rewrite=await send(path+'/'+retryId+'/rewrite',{note:'เล่าเรื่องเดียวให้ต่อเนื่อง'},'new-direction-rewrite');assert.equal(rewrite.status,201);const rewriteId=(await rewrite.json()).id;
    const fresh:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[rewriteId])).rows[0];assert.equal(fresh.director_version,1);assert.equal(fresh.storyboard,null);assert.equal(fresh.artwork,null);
    const created=await send(path,{topic:'แก้วใบเดิมกับเงา',story_mode:'general',presenter_kind:'legacy',director_version:0},'new-direction-create');assert.equal(created.status,201);const id=(await created.json()).id;
    assert.equal((await(await app.request(path+'/'+id)).json()).director_version,1,'client cannot downgrade new work');
    await db.query("UPDATE drafts SET status='failed',storyboard=$2,artwork=$3 WHERE id=$1",[id,JSON.stringify(good.storyboard),JSON.stringify(oldArt)]);
    const matching=await send(path+'/'+id+'/rewrite',{},'new-direction-retry');assert.equal(matching.status,201);const matchingId=(await matching.json()).id;
    const copied:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[matchingId])).rows[0];assert.equal(copied.director_version,1);assert.deepEqual(copied.storyboard,good.storyboard);assert.deepEqual(copied.artwork,oldArt);
    const ready=async(draft:any)=>db.query("UPDATE drafts SET status='ready',draft=$2 WHERE id=$1",[id,JSON.stringify(draft)]);
    await ready({...good,storyboard:undefined});assert.equal((await send(path+'/'+id+'/produce',{},'missing-direction-produce')).status,422);
    await ready({...good,storyboard:{...good.storyboard,direction_version:undefined,narrative:undefined}});assert.equal((await send(path+'/'+id,{title_th:'แก้ชื่อเท่านั้น'},'missing-direction-patch','PATCH')).status,422);
    await ready({...good,storyboard:{...good.storyboard,sound_policy:{mode:'quiet',owner_quote:'No SFX'}}});assert.equal((await send(path+'/'+id+'/produce',{},'forged-quiet-produce')).status,422);assert.equal((await send(path+'/'+id,{},'forged-quiet-patch','PATCH')).status,422);
    await ready({...good,sfx:[]});assert.equal((await send(path+'/'+id+'/produce',{},'missing-effects-produce')).status,422);
    await ready({...good,motion_review:undefined});assert.equal((await send(path+'/'+id+'/produce',{},'missing-review-produce')).status,422);assert.equal(jobs,0);
    await ready({...good,sfx:[...good.sfx,{...good.sfx[0],seg:'hook',at:'แก้วใบนี้',n:0,purpose:'',gain:.9}]});
    const badHook=await send(path+'/'+id+'/produce',{},'invalid-hook-cue-produce');assert.equal(badHook.status,422);const hookResult:any=await badHook.json();assert.ok(hookResult.problems.some((problem:string)=>problem.startsWith('direction sound cue hook/')));assert.equal(jobs,0,'the hook segment id must not turn sound policy errors into owner-soft warnings');
  }finally{globalThis.setTimeout=nativeTimeout;}
});
