import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('./studio.js');

for(const reference of [false,true])test(reference
  ? 'recurring pipeline uses the first reference in every shot and preserves an explicit visual style'
  : 'recurring pipeline invents a presenter without name or photo and keeps the stored setting through the ready draft',async()=>{
  const name=reference?'เบล':'น้องแสง';
  const script=[{id:'hook',beat:'hook',text:'ทำไมตื่นแล้ว ยังรู้สึกไม่สดชื่น'},...['water','light','routine'].map(id=>({id,beat:'rehook',text:'ลองดูสิ่งที่เกิดขึ้นในตอนเช้า เราจะอธิบายทีละขั้นด้วยภาพแก้วน้ำและนาฬิกา โดยแยกคำแนะนำของผู้ให้สัมภาษณ์ออกจากหลักฐานที่ตรวจสอบได้ ข้อมูลบางส่วนอาจแตกต่างกันในแต่ละคน'})),{id:'end',beat:'cta',text:'คุณอยากเริ่มจากข้อไหน ลองเล่าในคอมเมนต์ให้ฟังหน่อย'}];
  const plan={story_mode:'general',script,shots:script.map(s=>({seg:s.id,visual:'A cartoon presenter explains a clock beside a bright window',action:'The presenter points to the clock while speaking',camera:'Medium view with the presenter and diagram readable',characters:[name]})),character_notes:'The same fictional presenter keeps a blue shirt and dark short hair in every scene.'};
  const portrait={name,portrait_code:'def draw(c,t,p):\n  c.ellipse(0,0,80,110,"tan")\n  c.rect(-70,100,140,230,"navy")',portrait_description:'A distinct cartoon presenter with dark short hair and a blue shirt.'};
  const art='def ground(c):\n  c.rect(0,1200,1080,720,"cream")';
  const scenes=script.map(s=>({seg:s.id,type:'custom',code:`def draw(c,t,p):\n  c.grad("sky","cream")\n  ground(c)\n  c.person("${name}",400,700,260)`}));
  const metadata={recurring_character:false,title_th:'เช้าที่สดชื่น เริ่มจากอะไร',format:'mystery',style:'comic',sources:[{url:'https://example.org/sleep',publisher:'Example',published:String(new Date().getUTCFullYear()),claim:'ข้อมูลการนอน'}],claims:[{text:'ตัวอย่างรูทีนที่เสนอให้ทดลอง',kind:'assumption',source_ids:[]}],captions:{facebook:'เช้าที่สดชื่น',instagram:'เช้าที่สดชื่น',tiktok:'เช้าที่สดชื่น',youtube:'เช้าที่สดชื่น',twitter:'เช้าที่สดชื่น'}};
  const row={id:reference?'10000000-0000-0000-0000-000000000092':'10000000-0000-0000-0000-000000000091',topic:'อธิบายเรื่องนาฬิกาชีวิต',story_mode:'general',recurring_character:true,characters:reference?[{id:'20000000-0000-0000-0000-000000000092',name,look:{}}]:[],model:'gpt-6.1-sol',reasoning:'medium',style:reference?'paper_cutout':'auto',auto_produce:false};
  const expectedStyle=reference?'paper_cutout':'classic';
  let status='queued',calls=0,planWrites=0,artWrites=0,previews=0,refReads=0,fetchError:unknown,savedPlan:any,artwork:any,finalDraft:any;
  let resolveDone!:()=>void;const done=new Promise<void>(r=>{resolveDone=r;});
  const pool={query:async(sql:string,args:any[]=[])=>{
    if(sql.includes("WHERE status IN ('researching','writing')"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT id FROM drafts WHERE status='queued'"))return{rows:status==='queued'?[{id:row.id}]:[]};
    if(sql.startsWith('SELECT * FROM drafts WHERE id='))return{rows:[{...row,status}]};
    if(sql.startsWith('SELECT id, draft FROM drafts'))return{rows:[]};
    if(sql.startsWith('SELECT reference_image, thumb')){refReads++;return{rows:[]};}
    if(sql.startsWith("UPDATE drafts SET status='researching'"))status='researching';
    if(sql.startsWith("UPDATE drafts SET status='writing'"))status='writing';
    if(sql.startsWith('UPDATE drafts SET artwork=')){artWrites++;artwork=JSON.parse(args[1]);}
    if(sql.startsWith('UPDATE drafts SET storyboard=')){planWrites++;savedPlan=JSON.parse(args[1]);status='writing';}
    if(sql.startsWith('INSERT INTO art_checks')){
      previews++;const payload=JSON.parse(args[1]);assert.equal(payload.style,expectedStyle);assert.equal(payload.cast[0].name,name);assert.equal(payload.scenes.length,script.length);
      assert.ok(payload.scenes.every((s:any)=>s.code.includes(`c.person("${name}"`)));return{rows:[{id:'recurring-check-'+previews}]};
    }
    if(sql.startsWith('SELECT status, result FROM art_checks'))return{rows:[{status:'done',result:{scenes:script.map((s,i)=>({seg:s.id,errors:[],frames:i===0?['ZnJhbWU=','ZnJhbWU=','ZnJhbWU=']:['ZnJhbWU=','ZnJhbWU=']}))}}]};
    if(sql.startsWith('UPDATE drafts SET draft=')){status=args[4];finalDraft=JSON.parse(args[1]);resolveDone();}
    if(sql.startsWith("UPDATE drafts SET status='failed'")){status='failed';resolveDone();}
    return{rows:[],rowCount:1};
  }};
  const tool=(name:string,input:unknown,id:string)=>({type:'function_call',name,call_id:id,arguments:JSON.stringify(input)});
  const result=(body:any,id:string)=>body.input.find((item:any)=>item.type==='function_call_output'&&item.call_id===id)?.output||'';
  const steps:((body:any)=>any[])[]=[];
  steps.push(()=>[tool('plan_story',{...plan,recurring_character:false,shots:plan.shots.map(shot=>({...shot,characters:[]}))},'empty')]);
  steps.push(body=>{
    assert.equal(planWrites,0);assert.equal(artWrites,0);assert.match(result(body,'empty'),/same character in every shot/);
    return[tool('plan_story',{...plan,recurring_character:false,shots:plan.shots.map((shot,i)=>({...shot,characters:['ตัว'+['ก','ข','ค','ง','จ'][i]]}))},'alternating')];
  });
  if(reference)steps.push(body=>{
    assert.equal(planWrites,0);assert.equal(artWrites,0);assert.match(result(body,'alternating'),/same character in every shot/);
    return[tool('plan_story',{...plan,shots:plan.shots.map(shot=>({...shot,characters:['คนอื่น']}))},'wrong-reference')];
  });
  steps.push(body=>{
    assert.equal(planWrites,0);assert.equal(artWrites,0);
    assert.match(result(body,reference?'wrong-reference':'alternating'),reference?/recurring reference character "เบล" must appear in every shot/:/same character in every shot/);
    // Even an explicit model false cannot override the stored owner selection.
    return[{type:'web_search_call',status:'completed',action:{type:'open_page',url:'https://example.org/sleep'}},tool('plan_story',{...plan,recurring_character:false},'valid')];
  });
  steps.push(body=>{
    assert.equal(planWrites,1);assert.equal(savedPlan.recurring_character,true);assert.ok(savedPlan.shots.every((s:any)=>s.characters.includes(name)));
    assert.deepEqual(JSON.parse(result(body,'valid')).missing_characters,[name]);
    return[tool('draw_character',{character:portrait},'portrait')];
  });
  steps.push(()=>[tool('save_art',{art},'helpers')]);
  steps.push(()=>[tool('draw_scene',{scene:{...scenes[0],code:'def draw(c,t,p):\n  c.grad("sky","cream")\n  ground(c)'}},'hidden-presenter')]);
  steps.push(body=>{
    assert.equal(artwork.scenes.length,0);assert.match(result(body,'hidden-presenter'),/draw planned character/);
    return[tool('draw_scene',{scene:scenes[0]},'opening')];
  });
  let checkpoint:any,checkpointWrites=0;
  steps.push(()=>{
    checkpoint=structuredClone(artwork);checkpointWrites=artWrites;
    return[tool('revise_story',{segments:[{seg:script[1].id,characters:[]}]},'remove-presenter')];
  });
  steps.push(body=>{
    assert.equal(planWrites,1);assert.equal(artWrites,checkpointWrites);assert.deepEqual(artwork,checkpoint);
    assert.match(result(body,'remove-presenter'),/same character in every shot/);
    return[tool('draw_scene',{scene:scenes[1]},'scene-'+scenes[1].seg)];
  });
  for(const scene of scenes.slice(2))steps.push(()=>[tool('draw_scene',{scene},'scene-'+scene.seg)]);
  steps.push(()=>[tool('submit_episode',metadata,'preview')]);
  steps.push(body=>{
    assert.equal(status,'writing');assert.match(result(body,'preview'),/SAME main presenter.*EVERY sampled frame/);
    const preview=body.input.find((item:any)=>item.role==='user'&&Array.isArray(item.content)&&item.content[0]?.text?.startsWith('Preview frames'));
    assert.ok(preview);assert.equal(preview.content.filter((part:any)=>part.type==='input_image').length,script.length*2+1);
    return[tool('submit_episode',metadata,'approved')];
  });
  const nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout,timeout=nativeTimeout(resolveDone,5000);
  globalThis.fetch=async(_url,init)=>{
    try{
      const body=JSON.parse(String(init?.body));calls++;
      assert.equal(body.model,row.model);assert.equal(body.background,true);assert.ok(body.tools.some((t:any)=>t.name==='revise_story'));
      assert.match(body.instructions,/visible from opening frame zero through the end of EVERY shot/);
      assert.match(body.instructions,/Reuse the identity and clothing/);
      assert.match(body.instructions,/Source authors, clinicians, researchers and named experts remain attribution/);
      if(reference)assert.match(body.instructions,/first selected reference character "เบล"/);else assert.match(body.instructions,/without asking the owner for a name or photo/);
      assert.ok(body.input[0].content.includes(`set "style": "${expectedStyle}"`));
      const step=steps[calls-1];assert.ok(step,'unexpected extra model call');
      return Response.json({id:'resp_recurring_'+calls,status:'completed',output:step(body),usage:{input_tokens:10,output_tokens:10}});
    }catch(error){fetchError=error;return Response.json({error:{message:'mock assertion failed'}},{status:400});}
  };
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000||ms===1500?0:ms,...args)) as typeof setTimeout;
  try{
    registerStudio(new Hono(),pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('must not auto-produce')},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    await done;if(fetchError)throw fetchError;
    assert.equal(status,'ready');assert.equal(calls,steps.length);assert.equal(planWrites,1);assert.equal(previews,2);assert.equal(refReads,reference?1:0);
    assert.equal(finalDraft.recurring_character,true);assert.equal(finalDraft.storyboard.recurring_character,true);assert.equal(finalDraft.style,expectedStyle);assert.equal(finalDraft.cast[0].name,name);
    assert.deepEqual(finalDraft.storyboard,{...plan,recurring_character:true});assert.equal(finalDraft.scenes.length,script.length);
    assert.ok(finalDraft.scenes.every((scene:any)=>scene.code.includes(`c.person("${name}"`)));
  }finally{clearTimeout(timeout);globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;}
});
