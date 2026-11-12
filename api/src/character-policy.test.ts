import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {parseRecurringCharacter,parsePresenterKind,withCharacterPolicy,referencePresenterProblem,characterPolicyPrompt} from './character-policy.js';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio,Draft,checkDraft,systemPrompt}=await import('./studio.js');
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
  assert.equal(parsePresenterKind(undefined),'context');assert.equal(parsePresenterKind('context'),'context');assert.equal(parsePresenterKind(undefined,'legacy'),'legacy');
  for(const bad of [null,'human',true,{}])assert.throws(()=>parsePresenterKind(bad));
  assert.match(prompt,/Choose a person or animal because it fits the story/);assert.doesNotMatch(prompt,/orange tabby|blue hoodie/);
  const catPrompt=characterPolicyPrompt(true,undefined,'cat');assert.match(catPrompt,/orange tabby CAT/);assert.match(catPrompt,/cream muzzle/);assert.match(catPrompt,/whiskers, paws and tail/);assert.match(catPrompt,/SAME blue hoodie/);assert.match(catPrompt,/not a human with cat ears/);assert.match(catPrompt,/never substitute the generic c.cat/);
  const context=characterPolicyPrompt(false);assert.match(context,/people, animals, objects or character-free/);assert.match(context,/Draw the example itself/);assert.match(context,/need not appear in unrelated scenes/);assert.doesNotMatch(context,/orange tabby|blue hoodie|Invent ONE/);
  const legacy=characterPolicyPrompt(true,undefined,'legacy');assert.match(legacy,/Invent ONE fictional cartoon presenter suited to this topic/);assert.doesNotMatch(legacy,/orange tabby|blue hoodie/);
  const reference=characterPolicyPrompt(true,'อ้างอิงแรก','cat');assert.match(reference,/first selected reference/);assert.doesNotMatch(reference,/orange tabby|blue hoodie/);
  assert.doesNotMatch(characterPolicyPrompt(false,undefined,'cat'),/orange tabby|Invent ONE/);
});

test('general direction cuts to concrete examples with relevant characters instead of requiring one fixed set or cat',()=>{
  const prompt=systemPrompt({fc:false,ws:true},'general',1);
  assert.match(prompt,/choose people, animals, objects, environments/);
  assert.match(prompt,/Vary scene settings, framing, scale and relevant characters/);
  assert.match(prompt,/Cut to the concrete example or demonstration/);
  assert.match(prompt,/Do not lock the whole clip to one background/);
  const nameSeries=systemPrompt({fc:false,ws:true},'name_story',1);assert.match(nameSeries,/whenever that character appears and show only characters relevant to that shot/);assert.doesNotMatch(nameSeries,/reuse each cast member's portrait_code in every shot/);
  assert.doesNotMatch(prompt,/Every custom scene must actually draw at least one named cast member|Keep the background consistent across connected shots|Preserve the same identity throughout the episode; reuse each cast member's portrait_code in every shot/);
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
    const body={topic:'นาฬิกาชีวิตกับแสง',story_mode:'general',source_text:'บทความยาวต้นฉบับยังต้องตรวจ',recurring_character:true,presenter_kind:'legacy',narration_style:'child_10',model:'gpt-6.1-sol',auto_produce:false,characters:[]};
    const created=await send(path,body,'recurring-create-001');assert.equal(created.status,201,await created.clone().text());const {id}=await created.json();
    const stored:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[id])).rows[0];assert.equal(stored.recurring_character,true);assert.deepEqual(stored.characters,[]);assert.equal(stored.style,'classic');
    const detail:any=await(await app.request(path+'/'+id)).json();assert.equal(detail.recurring_character,true);assert.equal(detail.narration_style,'child_10');assert.equal(detail.source_text,body.source_text);
    const listing:any=await(await app.request(path)).json();assert.equal(listing.drafts.find((d:any)=>d.id===id).recurring_character,true);
    assert.equal((await send(path,{...body,recurring_character:false},'recurring-create-001')).status,409);
    assert.equal((await send(path,{...body,recurring_character:'true'},'recurring-bad-001')).status,422);
    const {recurring_character,...legacyBody}=body;
    const legacyId=(await(await send(path,legacyBody,'recurring-legacy-001')).json()).id;
    assert.equal((await db.query<{recurring_character:boolean}>('SELECT recurring_character FROM drafts WHERE id=$1',[legacyId])).rows[0].recurring_character,false);
    const good=generalDraft(true),art={art:good.art,cast:good.cast,scenes:good.scenes};
    await db.query("UPDATE drafts SET status='failed',director_version=0,presentation_version=0,storyboard=$2,artwork=$3 WHERE id=$1",[id,JSON.stringify(good.storyboard),JSON.stringify(art)]);
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

test('context default applies to new work while omitted retries preserve legacy and explicit cat checkpoints',async()=>{
  const oldDb=new PGlite();
  const oldId='10000000-0000-0000-0000-000000000088';
  const oldDraft=generalDraft(true),oldArt={art:oldDraft.art,cast:oldDraft.cast,scenes:oldDraft.scenes};
  const dir=new URL('../migrations/',import.meta.url);
  const nativeTimeout=globalThis.setTimeout;
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{
    for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){
      if(file==='022_presenter_kind.sql')await oldDb.query("INSERT INTO drafts(id,topic,status,story_mode,recurring_character,storyboard,artwork,source_text) VALUES($1,'มินเล่าเรื่องเดิม','failed','general',true,$2,$3,'ต้นฉบับเดิม')",[oldId,JSON.stringify(oldDraft.storyboard),JSON.stringify(oldArt)]);
      await oldDb.exec(readFileSync(new URL(file,dir),'utf8'));
    }
    await oldDb.exec(readFileSync(new URL('022_presenter_kind.sql',dir),'utf8'));
    const migrated:any=(await oldDb.query('SELECT * FROM drafts WHERE id=$1',[oldId])).rows[0];assert.equal(migrated.presenter_kind,'legacy');assert.deepEqual(migrated.storyboard,oldDraft.storyboard);assert.deepEqual(migrated.artwork,oldArt);
    const pool={query:async(sql:string,args:any[]=[])=>sql.startsWith("SELECT id FROM drafts WHERE status='queued'")?{rows:[]}:oldDb.query(sql,args)};
    const app=new Hono();registerStudio(app,pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('no production allowed')},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    const path='/app/api/studio/drafts';
    const send=(url:string,body:any,key:string,method='POST')=>app.request(url,{method,headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
    const retry=await send(path+'/'+oldId+'/rewrite',{},'legacy-min-retry');assert.equal(retry.status,201);const retryId=(await retry.json()).id;
    const resumed:any=(await oldDb.query('SELECT * FROM drafts WHERE id=$1',[retryId])).rows[0];assert.equal(resumed.presenter_kind,'legacy');assert.deepEqual(resumed.storyboard,oldDraft.storyboard);assert.deepEqual(resumed.artwork,oldArt);assert.equal(resumed.source_text,'ต้นฉบับเดิม');
    await oldDb.query("UPDATE drafts SET status='failed' WHERE id=$1",[retryId]);
    const changed=await send(path+'/'+retryId+'/rewrite',{presenter_kind:'cat'},'legacy-min-to-cat');assert.equal(changed.status,201);const catId=(await changed.json()).id;
    const cat:any=(await oldDb.query('SELECT * FROM drafts WHERE id=$1',[catId])).rows[0];assert.equal(cat.presenter_kind,'cat');assert.equal(cat.storyboard,null);assert.equal(cat.artwork,null);
    // An ordinary retry of an explicit cat checkpoint keeps its old art; opting into context clears that art.
    await oldDb.query("UPDATE drafts SET status='failed',director_version=0,presentation_version=0,storyboard=$2,artwork=$3 WHERE id=$1",[catId,JSON.stringify(oldDraft.storyboard),JSON.stringify(oldArt)]);
    const catRetry=await send(path+'/'+catId+'/rewrite',{},'saved-cat-retry-001');assert.equal(catRetry.status,201);const catRetryId=(await catRetry.json()).id;
    const catResumed:any=(await oldDb.query('SELECT * FROM drafts WHERE id=$1',[catRetryId])).rows[0];assert.equal(catResumed.presenter_kind,'cat');assert.equal(catResumed.recurring_character,true);assert.deepEqual(catResumed.storyboard,oldDraft.storyboard);assert.deepEqual(catResumed.artwork,oldArt);
    await oldDb.query("UPDATE drafts SET status='failed' WHERE id=$1",[catRetryId]);
    const contextRewrite=await send(path+'/'+catRetryId+'/rewrite',{presenter_kind:'context',recurring_character:false},'cat-to-story-context');assert.equal(contextRewrite.status,201);const contextId=(await contextRewrite.json()).id;
    const contextRow:any=(await oldDb.query('SELECT * FROM drafts WHERE id=$1',[contextId])).rows[0];assert.equal(contextRow.presenter_kind,'context');assert.equal(contextRow.recurring_character,false);assert.equal(contextRow.storyboard,null);assert.equal(contextRow.artwork,null);assert.equal(contextRow.source_text,'ต้นฉบับเดิม');
    const noHost=await send(path,{topic:'ฝนตกเกิดจากอะไร',story_mode:'general'},'new-context-no-host');assert.equal(noHost.status,201);const noHostRow:any=(await oldDb.query('SELECT * FROM drafts WHERE id=$1',[(await noHost.json()).id])).rows[0];assert.equal(noHostRow.presenter_kind,'context');assert.equal(noHostRow.recurring_character,false);
    const body={topic:'แมวอธิบายเรื่องแก้วน้ำ',story_mode:'general',recurring_character:true,characters:[],auto_produce:false};
    const created=await send(path,body,'new-cat-default-001');assert.equal(created.status,201);const newId=(await created.json()).id;
    const detail:any=await(await app.request(path+'/'+newId)).json();assert.equal(detail.presenter_kind,'context');assert.equal(detail.has_character_reference,false);
    const listing:any=await(await app.request(path)).json();assert.equal(listing.drafts.find((d:any)=>d.id===newId).presenter_kind,'context');
    assert.equal((await send(path,{...body,presenter_kind:'legacy'},'new-cat-default-001')).status,409);
    assert.equal((await send(path,{...body,presenter_kind:'human'},'new-cat-invalid-001')).status,422);
    assert.equal((await send(path+'/'+newId+'/rewrite',{presenter_kind:null},'cat-rewrite-invalid')).status,422);
    // Turning recurring mode ON for an older character-free story adopts the current context default.
    const offId='10000000-0000-0000-0000-000000000087';
    await oldDb.query("INSERT INTO drafts(id,topic,status,story_mode) VALUES($1,'เรื่องเก่าไม่มีตัวละคร','failed','general')",[offId]);
    const enabled=await send(path+'/'+offId+'/rewrite',{recurring_character:true},'old-off-turns-on');assert.equal(enabled.status,201);const enabledId=(await enabled.json()).id;
    const enabledRow:any=(await oldDb.query('SELECT * FROM drafts WHERE id=$1',[enabledId])).rows[0];assert.equal(enabledRow.presenter_kind,'context');assert.equal(enabledRow.recurring_character,true);
    const referenceId='20000000-0000-0000-0000-000000000087';await oldDb.query("INSERT INTO characters(id,name,look) VALUES($1,'รูปเจ้าของ','{}')",[referenceId]);
    const refCreated=await send(path,{...body,characters:[referenceId]},'cat-reference-wins');assert.equal(refCreated.status,201);const refId=(await refCreated.json()).id;
    const refDetail:any=await(await app.request(path+'/'+refId)).json();assert.equal(refDetail.presenter_kind,'context');assert.equal(refDetail.has_character_reference,true);
    await oldDb.query("UPDATE drafts SET status='ready',draft=$2 WHERE id=$1",[oldId,JSON.stringify(oldDraft)]);
    assert.equal((await send(path+'/'+oldId,{presenter_kind:'cat'},'ready-kind-change','PATCH')).status,422);
    assert.equal((await send(path+'/'+oldId,{presenter_kind:null},'ready-kind-invalid','PATCH')).status,422);
    assert.equal((await send(path+'/'+oldId,{title_th:'ยังคงตัวละครเดิม'},'ready-kind-preserve','PATCH')).status,200);
    const patched:any=(await oldDb.query('SELECT draft FROM drafts WHERE id=$1',[oldId])).rows[0];assert.equal(patched.draft.presenter_kind,'legacy');assert.deepEqual(patched.draft.cast,oldDraft.cast);
  }finally{globalThis.setTimeout=nativeTimeout;await oldDb.close();}
});
