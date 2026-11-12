import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('./studio.js');

const script=[{id:'hook',beat:'hook',text:'ทำไมตื่นแล้ว ยังรู้สึกไม่สดชื่น'},...['water','light','routine'].map(id=>({id,beat:'rehook',text:'ลองดูสิ่งที่เกิดขึ้นในตอนเช้า เราจะอธิบายทีละขั้นด้วยภาพแก้วน้ำและนาฬิกา โดยแยกคำแนะนำของผู้ให้สัมภาษณ์ออกจากหลักฐานที่ตรวจสอบได้ ข้อมูลบางส่วนอาจแตกต่างกันในแต่ละคน'})),{id:'end',beat:'cta',text:'คุณอยากเริ่มจากข้อไหน ลองเล่าในคอมเมนต์ให้ฟังหน่อย'}];
const basePlan={story_mode:'general',script,shots:script.map(s=>({seg:s.id,visual:'A clock beside a window makes a sequence of daily events visible',action:'A light ray reaches the clock and moves its schedule marker',camera:'A readable close view of the clock and moving marker',characters:[]})),character_notes:'Use clocks, light rays and diagrams; no human or animal characters.'};
const narrative={premise:'A daily clock explains why the same morning can feel different.',central_question:'How does light help connect a daily schedule to the outside world?',throughline:'Follow one clock as the window light moves its schedule marker.',payoff:'The marker reaches the next day and links the opening question to the outcome.'};
const directedPlan={...basePlan,narrative,shots:basePlan.shots.map((shot,i)=>({...shot,continuity:{from:i?'The previous light marker carries into this clock view.':'The opening clock shows an unanswered morning question.',to:i===basePlan.shots.length-1?'The final marker closes the opening question and invites a response.':'The light marker moves toward the next daily event.'},motion_beats:[{start:0,end:0.5,action:'The clock hand and light marker move to demonstrate the initial cause',purpose:'Make the initial causal step clearly visible'},{start:0.5,end:1,action:'The marker reaches its target and the clock reveals the outcome',purpose:'Make the consequence and next-shot handoff clear'}]}))};
const art='def ground(c):\n  c.rect(0,1200,1080,720,"cream")';
const scenes=script.map(s=>({seg:s.id,type:'custom',code:'def draw(c,t,p):\n  c.grad("sky","cream")\n  ground(c)\n  c.circle(540+sin(t)*60,700,130,"teal")\n  c.line(540,700,540+cos(t)*100,700+sin(t)*100,"navy",8)'}));
const soundCues=['water','light','routine'].flatMap(seg=>[{sfx:seg==='water'?'tick':seg==='light'?'ding':'whoosh',seg,at:'ลองดู',gain:0.35,purpose:'Mark the visible start of the clock movement'},{sfx:seg==='water'?'ding':seg==='light'?'whoosh':'tick',seg,at:'ภาพแก้วน้ำและนาฬิกา',gain:0.35,purpose:'Emphasise the visible marker reaching its target'}]);
const metadata={title_th:'เช้าที่สดชื่น เริ่มจากอะไร',format:'mystery',style:'classic',sources:[{url:'https://example.org/sleep',publisher:'Example',published:String(new Date().getUTCFullYear()),claim:'ข้อมูลการนอน'}],claims:[{text:'ตัวอย่างรูทีนที่เสนอให้ทดลอง',kind:'assumption',source_ids:[]}],captions:{facebook:'เช้าที่สดชื่น',instagram:'เช้าที่สดชื่น',tiktok:'เช้าที่สดชื่น',youtube:'เช้าที่สดชื่น',twitter:'เช้าที่สดชื่น'}};
const motionReview='The clock hand and light marker move to explain the cause; the brief pause lets viewers read the outcome before the next action.';
const tool=(name:string,input:unknown,id:string)=>({type:'function_call',name,call_id:id,arguments:JSON.stringify(input)});
const result=(body:any,id:string)=>body.input.find((item:any)=>item.type==='function_call_output'&&item.call_id===id)?.output||'';

const layouts=['hook','illustration','list','illustration','outro'];
for(const kind of ['directed','context','presentation','legacy']){const legacy=kind==='legacy',presentation=kind==='presentation',context=kind==='context'||presentation;const testPlan=context?{...directedPlan,shots:directedPlan.shots.map(shot=>({...shot,...(presentation?{layout:layouts[directedPlan.shots.indexOf(shot)]}:{}),subjects:[{id:'clock',description:'นาฬิกาและเข็มที่กำลังเคลื่อนเพื่ออธิบายตัวอย่าง'},{id:'marker',description:'จุดแสงที่เลื่อนแสดงจังหวะเวลาในแผนภาพ'}]}))}:directedPlan;const testScenes=context?scenes.map(scene=>({...scene,depicted_subjects:['clock','marker'],...(presentation?{headline:{text:'นาฬิกาชีวิต'},graphic:layouts[scenes.indexOf(scene)]==='hook'?{type:'hook',lines:[{text:'ทำไมยังง่วง?'}]}:layouts[scenes.indexOf(scene)]==='list'?{type:'list',items:[{text:'ดูภาพ',at:'ลองดู'},{text:'นาฬิกา',at:'ภาพแก้วน้ำและนาฬิกา'}]}:layouts[scenes.indexOf(scene)]==='outro'?{type:'outro',lines:[{text:'คุณอยากเริ่มข้อไหน?',at:'คุณอยาก'}],icon_at:'คอมเมนต์'}:{type:'illustration'}}:{})})):scenes;test(legacy
  ? 'a saved legacy storyboard resumes without imposing directed sound or motion review'
  : presentation?'classic presentation reaches every drawing, preview and final package':context?'contextual story carries actual planned subjects through saved drawings and preview review': 'new directed story requires sound design and delivers motion reports and strips before readiness',async()=>{
  const row={id:legacy?'10000000-0000-0000-0000-000000000095':'10000000-0000-0000-0000-000000000094',director_version:legacy?0:1,presentation_version:presentation?1:0,...(context?{presenter_kind:'context'}:{}),topic:'เรื่องนาฬิกาชีวิต',note:'อยากให้เล่าเรื่องต่อเนื่องด้วยภาพเข้าใจง่าย',story_mode:'general',characters:[],model:'gpt-6.1-sol',reasoning:'medium',style:'classic',auto_produce:false,...(legacy?{storyboard:structuredClone(basePlan),artwork:{art,art_saved:true,cast:[],scenes:structuredClone(scenes)}}:{})};
  let status='queued',calls=0,planWrites=0,artWrites=0,previews=0,fetchError:unknown,finalDraft:any,savedPlan:any=legacy?structuredClone(basePlan):null,artwork:any=legacy?structuredClone(row.artwork):null;
  const previewPayloads:any[]=[];
  let resolveDone!:()=>void;const done=new Promise<void>(resolve=>{resolveDone=resolve;});
  const pool={query:async(sql:string,args:any[]=[])=>{
    if(sql.includes("WHERE status IN ('researching','writing')"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT id FROM drafts WHERE status='queued'"))return{rows:status==='queued'?[{id:row.id}]:[]};
    if(sql.startsWith('SELECT * FROM drafts WHERE id='))return{rows:[{...row,status}]};
    if(sql.startsWith('SELECT id, draft FROM drafts'))return{rows:[]};
    if(sql.startsWith("UPDATE drafts SET status='researching'"))status='researching';
    if(sql.startsWith("UPDATE drafts SET status='writing'"))status='writing';
    if(sql.startsWith('UPDATE drafts SET artwork=')){artWrites++;artwork=JSON.parse(args[1]);}
    if(sql.startsWith('UPDATE drafts SET storyboard=')){planWrites++;savedPlan=JSON.parse(args[1]);status='writing';}
    if(sql.startsWith('INSERT INTO art_checks')){
      previews++;const payload=JSON.parse(args[1]);previewPayloads.push(payload);
      assert.equal(payload.motion_review===true,!legacy,'only version-one stories request motion diagnostics');
      return{rows:[{id:'direction-check-'+previews}]};
    }
    if(sql.startsWith('SELECT status, result FROM art_checks'))return{rows:[{status:'done',result:{presentation_version:presentation?1:0,scenes:script.map((s,i)=>({seg:s.id,errors:[],frames:i===0?['ZnJhbWU=','ZnJhbWU=','ZnJhbWU=']:['ZnJhbWU=','ZnJhbWU='],...(!legacy?{motion:{method:'raw-scene-layer-differences',diagnostic_only:true,complete:previews!==1||i!==0,samples:previews===1&&i===0?0:8,held_intervals:[{start:0.25,end:0.375,seconds:0.125}],note:'sampling diagnostics for '+s.id},motion_strip:previews===1&&i===0?null:'c3RyaXA='}:{})}))}}]};
    if(sql.startsWith('UPDATE drafts SET draft=')){status=args[4];finalDraft=JSON.parse(args[1]);resolveDone();}
    if(sql.startsWith("UPDATE drafts SET status='failed'")){status='failed';resolveDone();}
    return{rows:[],rowCount:1};
  }};
  const steps:((body:any)=>any[])[]=[];
  if(!legacy){
    steps.push(()=>[tool('plan_story',{...directedPlan,sound_policy:{mode:'quiet',owner_quote:'ไม่ใช้เสียงเอฟเฟกต์'}},'forged-quiet')]);
    steps.push(body=>{
      assert.equal(planWrites,0);assert.equal(artWrites,0);assert.match(result(body,'forged-quiet'),/quiet|owner|เจ้าของ|quote/i);
      // The server supplies version one and the default designed policy even when omitted by the model.
      return[{type:'web_search_call',status:'completed',action:{type:'open_page',url:'https://example.org/sleep'}},tool('plan_story',testPlan,'planned')];
    });
    steps.push(()=>{
      assert.equal(planWrites,1);assert.equal(savedPlan.direction_version,1);assert.equal(savedPlan.sound_policy.mode,'designed');assert.deepEqual(savedPlan.narrative,narrative);if(context)assert.equal(savedPlan.depiction_version,1);
      return[tool('save_art',{art},'helpers')];
    });
    for(const scene of testScenes)steps.push(()=>[tool('draw_scene',{scene},'scene-'+scene.seg)]);
    steps.push(()=>[tool('submit_episode',{...metadata,sfx:[]},'missing-sound')]);
    steps.push(body=>{
      assert.equal(previews,0,'missing sound design must be repaired before visual review');
      assert.match(result(body,'missing-sound'),/sound|sfx|เสียง/i);assert.equal(artwork.scenes.length,scenes.length);
      return[tool('submit_episode',{...metadata,sfx:soundCues},'incomplete-motion')];
    });
    steps.push(body=>{
      assert.equal(status,'writing');assert.equal(previews,1);assert.match(result(body,'incomplete-motion'),/motion|temporal|sampling|เคลื่อนไหว/i);
      assert.equal(body.input.some((item:any)=>item.role==='user'&&Array.isArray(item.content)&&item.content[0]?.text?.startsWith('Preview frames')),false,'incomplete motion sampling cannot be presented as a reviewed sequence');
      assert.equal(artwork.scenes.length,scenes.length,'a worker diagnostic retry retains saved drawings');
      return[tool('submit_episode',{...metadata,sfx:soundCues},'preview')];
    });
  }else{
    steps.push(()=>[{type:'web_search_call',status:'completed',action:{type:'open_page',url:'https://example.org/sleep'}},tool('plan_story',{...basePlan,direction_version:1},'legacy-upgrade')]);
    steps.push(body=>{
      assert.equal(planWrites,1);assert.equal(savedPlan.direction_version,undefined);assert.deepEqual(savedPlan,basePlan);assert.deepEqual(artwork.scenes,scenes,'ignoring a model upgrade preserves the legacy checkpoints');
      assert.equal(JSON.parse(result(body,'legacy-upgrade')).missing_scenes.length,0);
      return[tool('submit_episode',{...metadata,direction_version:1,sfx:[]},'preview')];
    });
  }
  steps.push(body=>{
    assert.equal(status,'writing');assert.equal(previews,legacy?1:2);assert.match(result(body,'preview'),/VISUAL REVIEW/);if(context){assert.match(result(body,'preview'),/DEPICTION REVIEW/);assert.match(result(body,'preview'),/clock/);assert.match(result(body,'preview'),/marker/);}
    const shown=body.input.filter((item:any)=>item.role==='user'&&Array.isArray(item.content)&&item.content[0]?.text?.startsWith('Preview frames'));
    assert.equal(shown.length,1);
    const images=shown[0].content.filter((part:any)=>part.type==='input_image');
    if(!legacy){
      const allInput=JSON.stringify(body.input);for(const segment of script)assert.ok(allInput.includes('sampling diagnostics for '+segment.id),'motion report for '+segment.id+' reaches the reviewer');
      assert.equal(images.filter((part:any)=>part.image_url==='data:image/jpeg;base64,c3RyaXA=').length,script.length,'one chronological motion strip is supplied for every scene');
      assert.equal(images.length,script.length*3+1);
    }else{
      assert.equal(images.length,script.length*2+1);assert.equal(savedPlan.direction_version,undefined);assert.equal(planWrites,1);
    }
    return[tool('submit_episode',{...metadata,...(!legacy?{sfx:soundCues,motion_review:motionReview}:{sfx:[],direction_version:1})},'reviewed')];
  });
  const nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout,timeout=nativeTimeout(resolveDone,5000);
  globalThis.fetch=async(_url,init)=>{
    try{
      const body=JSON.parse(String(init?.body));calls++;
      assert.equal(body.model,row.model);assert.equal(body.background,true);
      const step=steps[calls-1];assert.ok(step,'unexpected model call '+calls);
      return Response.json({id:'resp_direction_'+calls,status:'completed',output:step(body),usage:{input_tokens:10,output_tokens:10}});
    }catch(error){fetchError=error;return Response.json({error:{message:'mock assertion failed'}},{status:400});}
  };
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000||ms===1500?0:ms,...args)) as typeof setTimeout;
  try{
    registerStudio(new Hono(),pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('must not produce')},estimateCredits:()=>100,validate:(pkg:any)=>{if(context)assert.deepEqual(pkg.direction.shots[0].subjects,savedPlan.shots[0].subjects);return[];},researchFreshness:()=>[]});
    await done;if(fetchError)throw fetchError;
    assert.equal(status,'ready');if(presentation){assert.equal(finalDraft.storyboard.presentation_version,1);assert.deepEqual(finalDraft.scenes.map((s:any)=>s.graphic.type),layouts);assert.ok(previewPayloads.every(p=>p.presentation_version===1));}
    assert.equal(calls,steps.length);assert.equal(previews,legacy?2:3);assert.equal(finalDraft.storyboard.direction_version,legacy?undefined:1);
    assert.equal(finalDraft.sfx.length,legacy?0:6);if(context){assert.equal(finalDraft.presenter_kind,'context');assert.equal(finalDraft.recurring_character,undefined);assert.equal(finalDraft.storyboard.depiction_version,1);assert.ok(finalDraft.scenes.every((scene:any)=>scene.depicted_subjects.length===2));}
    if(!legacy){assert.equal(finalDraft.motion_review,motionReview);assert.deepEqual(finalDraft.storyboard.sound_policy,{mode:'designed'});assert.equal(new Set(finalDraft.sfx.map((cue:any)=>cue.sfx)).size,3);}
    else assert.deepEqual(finalDraft.storyboard,basePlan);
    assert.ok(previewPayloads.every(payload=>(payload.motion_review===true)===!legacy));
  }finally{clearTimeout(timeout);globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;}
});
}
