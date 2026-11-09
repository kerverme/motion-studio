import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {parseRecurringCharacter,withCharacterPolicy,referencePresenterProblem,characterPolicyPrompt} from './character-policy.js';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio,Draft,checkDraft}=await import('./studio.js');
const db=new PGlite();after(()=>db.close());

function generalDraft(recurring=false){
  const script=[{id:'hook',beat:'hook',text:'ทำไมตื่นแล้ว ยังรู้สึกไม่สดชื่น'},...['water','light','routine'].map(id=>({id,beat:'rehook',text:'ลองดูสิ่งที่เกิดขึ้นในตอนเช้า เราจะอธิบายทีละขั้นด้วยภาพแก้วน้ำและนาฬิกา โดยแยกคำแนะนำของผู้ให้สัมภาษณ์ออกจากหลักฐานที่ตรวจสอบได้ ข้อมูลบางส่วนอาจแตกต่างกันในแต่ละคน'})),{id:'end',beat:'cta',text:'คุณอยากเริ่มจากข้อไหน ลองเล่าในคอมเมนต์ให้ฟังหน่อย'}];
  const cast=recurring?[{name:'น้องแสง',portrait_description:'A fictional cartoon presenter with a blue shirt',portrait_code:'def draw(c,t,p):\n  c.circle(0,0,80,"tan")'}]:[];
  const storyboard={story_mode:'general',...(recurring?{recurring_character:true}:{}),script,shots:script.map(s=>({seg:s.id,visual:'A glass of water next to a clock and a bright window',action:'Sunlight moves across the clock',camera:'Close-up with a slow pan',characters:cast.map(c=>c.name)})),character_notes:'Blue-shirt presenter keeps the same identity and clothes.'};
  return Draft.parse({story_mode:'general',...(recurring?{recurring_character:true}:{}),storyboard,script,title_th:'เช้าที่สดชื่น เริ่มจากอะไร',format:'mystery',cast,scenes:script.map(s=>({seg:s.id,type:'custom',code:'def draw(c,t,p):\n  c.grad("sky","cream")\n  c.rect(400,600,240,360,"teal")'+(recurring?'\n  c.person("น้องแสง",260,900,240)':'')})),art:'',sources:[{url:'https://example.org/sleep',publisher:'Example',published:String(new Date().getUTCFullYear()),claim:'ข้อมูลการนอน'}],claims:[{text:'ตัวอย่างรูทีนที่เสนอให้ทดลอง',kind:'assumption',source_ids:[]}],captions:{facebook:'เช้าที่สดชื่น',instagram:'เช้าที่สดชื่น',tiktok:'เช้าที่สดชื่น',youtube:'เช้าที่สดชื่น',twitter:'เช้าที่สดชื่น'}});
}

test('stored recurring policy overrides model flags, requires first reference, and keeps legacy API optional',()=>{
  assert.equal(parseRecurringCharacter(undefined),false);assert.equal(parseRecurringCharacter(true),true);assert.equal(parseRecurringCharacter(false),false);
  for(const bad of [null,'true',1,{},[]])assert.throws(()=>parseRecurringCharacter(bad));
  assert.deepEqual(withCharacterPolicy({recurring_character:false,name:'x'},true),{name:'x',recurring_character:true});
  assert.deepEqual(withCharacterPolicy({recurring_character:true,name:'x'},false),{name:'x'});
  const plan={shots:[{seg:'a',characters:['first','other']},{seg:'b',characters:['other']}]};
  assert.match(referencePresenterProblem(plan,true,'first')!,/missing from: b/);assert.equal(referencePresenterProblem(plan,false,'first'),null);
  const prompt=characterPolicyPrompt(true);assert.match(prompt,/Invent ONE fictional/);assert.match(prompt,/without asking the owner for a name or photo/);assert.match(prompt,/opening frame zero/);assert.match(prompt,/EVERY shot/);assert.match(prompt,/named experts remain attribution/);
  assert.match(characterPolicyPrompt(true,'อ้างอิงแรก'),/first selected reference character "อ้างอิงแรก"/);
});

test('final draft validation requires common presenter in cast and real direct drawing, while OFF accepts no people',()=>{
  const optional=generalDraft(),on=generalDraft(true);
  assert.deepEqual(checkDraft(optional,null).problems,[]);assert.deepEqual(checkDraft(on,null).problems,[]);
  assert.ok(checkDraft({...optional,recurring_character:true},null).problems.some(p=>/recurring character/.test(p)));
  const hidden=structuredClone(on);hidden.scenes[1].code='def draw(c,t,p):\n  c.grad("sky","cream")\n  # c.person("น้องแสง",260,900,240)';
  assert.ok(checkDraft(hidden,null).problems.some(p=>p.includes('draw "น้องแสง"')));
  assert.ok(checkDraft({...on,cast:[]},null).problems.some(p=>p.includes('not in cast')));
  assert.ok(checkDraft(on,null,[],{requiredNames:['รูปแรก']}).problems.some(p=>p.includes('recurring reference character "รูปแรก"')));
  assert.ok(checkDraft({...on,storyboard:undefined},null).problems.some(p=>p.includes('Call plan_story')));
});

test('routes persist opt-in with no name/photo, preserve first reference order and retry choice, and prevent ready-policy bypass',async()=>{
  const dir=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(file,dir),'utf8'));
  await db.exec(readFileSync(new URL('021_recurring_character.sql',dir),'utf8'));
  let jobs=0;
  const pool={query:async(sql:string,args:any[]=[])=>sql.startsWith("SELECT id FROM drafts WHERE status='queued'")?{rows:[]}:db.query(sql,args)};
  const nativeTimeout=globalThis.setTimeout;
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{
    const app=new Hono();registerStudio(app,pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{jobs++;await db.query("INSERT INTO jobs(id) VALUES('10000000-0000-0000-0000-000000000099')");return{status:201,body:{id:'10000000-0000-0000-0000-000000000099'}}},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    const path='/app/api/studio/drafts';
    const send=(url:string,body:any,key:string,method='POST')=>app.request(url,{method,headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
    const body={topic:'นาฬิกาชีวิตกับแสง',story_mode:'general',source_text:'บทความยาวต้นฉบับยังต้องตรวจ',recurring_character:true,narration_style:'child_10',model:'gpt-6.1-sol',auto_produce:false,characters:[]};
    const created=await send(path,body,'recurring-create-001');assert.equal(created.status,201,await created.clone().text());const {id}=await created.json();
    const stored:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[id])).rows[0];assert.equal(stored.recurring_character,true);assert.deepEqual(stored.characters,[]);assert.equal(stored.style,'auto');
    const detail:any=await(await app.request(path+'/'+id)).json();assert.equal(detail.recurring_character,true);assert.equal(detail.narration_style,'child_10');assert.equal(detail.source_text,body.source_text);
    const listing:any=await(await app.request(path)).json();assert.equal(listing.drafts.find((d:any)=>d.id===id).recurring_character,true);
    assert.equal((await send(path,{...body,recurring_character:false},'recurring-create-001')).status,409);
    assert.equal((await send(path,{...body,recurring_character:'true'},'recurring-bad-001')).status,422);
    const {recurring_character,...legacyBody}=body;
    const legacyId=(await(await send(path,legacyBody,'recurring-legacy-001')).json()).id;
    assert.equal((await db.query<{recurring_character:boolean}>('SELECT recurring_character FROM drafts WHERE id=$1',[legacyId])).rows[0].recurring_character,false);
    const good=generalDraft(true),art={art:good.art,cast:good.cast,scenes:good.scenes};
    await db.query("UPDATE drafts SET status='failed',storyboard=$2,artwork=$3 WHERE id=$1",[id,JSON.stringify(good.storyboard),JSON.stringify(art)]);
    const childId=(await(await send(path+'/'+id+'/rewrite',{},'recurring-retry-001')).json()).id;
    const child:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[childId])).rows[0];assert.equal(child.recurring_character,true);assert.deepEqual(child.storyboard,good.storyboard);assert.deepEqual(child.artwork,art);assert.equal(child.narration_style,'child_10');assert.equal(child.source_text,body.source_text);
    await db.query("UPDATE drafts SET status='failed' WHERE id=$1",[childId]);
    const offId=(await(await send(path+'/'+childId+'/rewrite',{recurring_character:false},'recurring-off-001')).json()).id;
    const off:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[offId])).rows[0];assert.equal(off.recurring_character,false);assert.equal(off.storyboard,null);assert.equal(off.artwork,null);
    const older='20000000-0000-0000-0000-000000000001',selectedFirst='20000000-0000-0000-0000-000000000002';
    await db.query("INSERT INTO characters(id,name,look,created_at) VALUES($1,'เก่ากว่า','{}',now()-interval '1 day'),($2,'เลือกก่อน','{}',now())",[older,selectedFirst]);
    const refId=(await(await send(path,{...body,characters:[selectedFirst,older]},'recurring-refs-001')).json()).id;
    const refs:any=(await db.query('SELECT characters FROM drafts WHERE id=$1',[refId])).rows[0];assert.deepEqual(refs.characters.map((c:any)=>c.id),[selectedFirst,older]);
    // A stale or malicious ready JSON cannot turn the stored ON policy off before editing/production.
    const withoutPeople=generalDraft(false);
    await db.query("UPDATE drafts SET status='ready',draft=$2 WHERE id=$1",[id,JSON.stringify({...withoutPeople,recurring_character:false})]);
    assert.equal((await send(path+'/'+id+'/produce',{},'recurring-produce-invalid')).status,422);
    assert.equal((await send(path+'/'+id,{title_th:'เปลี่ยนชื่ออย่างเดียว'},'recurring-patch-invalid','PATCH')).status,422);
    assert.equal((await send(path+'/'+id,{recurring_character:false},'recurring-patch-toggle','PATCH')).status,422);
    assert.equal(jobs,0);
    // A valid reference name must never turn a policy failure into a soft storytelling warning.
    await db.query("UPDATE drafts SET draft=$2,characters=$3 WHERE id=$1",[id,JSON.stringify(good),JSON.stringify([{name:'action'}])]);
    assert.equal((await send(path+'/'+id,{title_th:'ชื่ออ้างอิงซ้ำคำกฎ'},'recurring-reference-soft','PATCH')).status,422);
    assert.equal((await send(path+'/'+id+'/produce',{},'recurring-reference-soft-produce')).status,422);
    const missingOpening=structuredClone(good);missingOpening.scenes[0].code='def draw(c,t,p):\n  c.grad("sky","cream")';
    await db.query("UPDATE drafts SET draft=$2,characters='[]' WHERE id=$1",[id,JSON.stringify(missingOpening)]);
    assert.equal((await send(path+'/'+id,{title_th:'ไม่มีผู้เล่าในฉาก hook'},'recurring-hook-soft','PATCH')).status,422);
    assert.equal((await send(path+'/'+id+'/produce',{},'recurring-hook-soft-produce')).status,422);
    assert.equal(jobs,0);
    await db.query("UPDATE drafts SET draft=$2 WHERE id=$1",[id,JSON.stringify(good)]);
    assert.equal((await send(path+'/'+id,{title_th:'เช้าที่สดชื่นกับตัวละครเดิม'},'recurring-patch-valid','PATCH')).status,200);
    const saved:any=(await db.query('SELECT draft FROM drafts WHERE id=$1',[id])).rows[0];assert.equal(saved.draft.recurring_character,true);assert.equal(saved.draft.storyboard.recurring_character,true);
    assert.equal((await send(path+'/'+id+'/produce',{},'recurring-produce-valid')).status,201);assert.equal(jobs,1);
  }finally{globalThis.setTimeout=nativeTimeout;}
});
