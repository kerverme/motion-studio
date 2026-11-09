import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('./studio.js');

test('LLM partial repair keeps five checkpoints, reports exactly one missing scene, and redraws only that scene',async()=>{
  const ids=['question','schedule','light','dark','different','choice'];
  const originalPlan={story_mode:'general',script:ids.map((id,i)=>({id,text:'เรื่องเล่าที่ตรวจแล้ว ใช้คำง่ายให้เข้าใจ',beat:i===0?'hook':i===5?'cta':'info'})),shots:ids.map(seg=>({seg,visual:'A clock and daily schedule without any people',action:'The clock hand moves beside the schedule',camera:'Medium shot',characters:[]})),character_notes:'No people or animal mascots.'};
  const originalArtwork={art:'def floor(c):\n    c.rect(0,1400,1080,520,"tan")',art_saved:true,cast:[],scenes:ids.map(seg=>({seg,type:'custom',code:'def draw(c,t,p):\n    c.grad("sky","cream")\n    if t>=c.cue("เรื่องเล่าที่ตรวจแล้ว"):\n        floor(c)'}))};
  let savedPlan:any=structuredClone(originalPlan),savedArtwork:any=structuredClone(originalArtwork),calls=0,planWrites=0,status='queued',fetchError:unknown;
  const row={id:'10000000-0000-0000-0000-000000000090',topic:'ทำไมง่วงไม่พร้อมกัน',story_mode:'general',characters:[],model:'gpt-6.1-sol',reasoning:'medium',auto_produce:false,storyboard:originalPlan,artwork:originalArtwork};
  let resolveDone!:()=>void;const done=new Promise<void>(resolve=>{resolveDone=resolve;});
  const pool={query:async(sql:string,args:any[]=[])=>{
    if(sql.includes("WHERE status IN ('researching','writing')"))return{rows:[]};
    if(sql.includes("SELECT id FROM drafts WHERE status='queued'"))return{rows:status==='queued'?[{id:row.id}]:[]};
    if(sql.startsWith('SELECT * FROM drafts WHERE id='))return{rows:[{...row,status}]};
    if(sql.startsWith('SELECT id, draft FROM drafts'))return{rows:[]};
    if(sql.startsWith("UPDATE drafts SET status='researching'"))status='researching';
    if(sql.startsWith('UPDATE drafts SET artwork='))savedArtwork=JSON.parse(args[1]);
    if(sql.startsWith('UPDATE drafts SET storyboard=')){savedPlan=JSON.parse(args[1]);planWrites++;status='writing';}
    if(sql.startsWith("UPDATE drafts SET status='failed'")){status='failed';resolveDone();}
    return{rows:[],rowCount:1};
  }};
  const nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout,timeout=nativeTimeout(resolveDone,5000);
  const tool=(name:string,input:unknown,id:string)=>({type:'function_call',name,call_id:id,arguments:JSON.stringify(input)});
  globalThis.fetch=async(_url,init)=>{
    try{
      calls++;const body=JSON.parse(String(init?.body));
      assert.ok(body.tools.some((tool:any)=>tool.name==='revise_story'));
      assert.match(body.instructions,/ONLY the affected segment IDs/);
      let output:any[];
      if(calls===1)output=[tool('revise_story',{segments:[{seg:'not_saved',text:'เปลี่ยนฉากที่ไม่มีจริง'}]},'bad')];
      else if(calls===2){
        assert.equal(planWrites,0);assert.deepEqual(savedPlan,originalPlan);assert.deepEqual(savedArtwork,originalArtwork);
        assert.ok(body.input.some((item:any)=>item.call_id==='bad'&&item.type==='function_call_output'&&item.output.includes('not in the saved storyboard')));
        output=[tool('revise_story',{segments:[{seg:'different',text:'แสงที่เจอในแต่ละวัน และอายุก็มีส่วน'}]},'repair')];
      }else if(calls===3){
        assert.equal(planWrites,1);assert.equal(savedPlan.script.find((line:any)=>line.id==='different').text,'แสงที่เจอในแต่ละวัน และอายุก็มีส่วน');
        for(const id of ids.filter(id=>id!=='different')){
          assert.deepEqual(savedPlan.script.find((line:any)=>line.id===id),originalPlan.script.find(line=>line.id===id));
          assert.deepEqual(savedPlan.shots.find((shot:any)=>shot.seg===id),originalPlan.shots.find(shot=>shot.seg===id));
        }
        assert.deepEqual(savedArtwork.scenes,originalArtwork.scenes.filter(scene=>scene.seg!=='different'));
        const result=JSON.parse(body.input.find((item:any)=>item.type==='function_call_output'&&item.call_id==='repair').output);
        assert.deepEqual(result.missing_scenes,['different']);assert.deepEqual(result.saved_scenes,ids.filter(id=>id!=='different'));
        assert.deepEqual(result.missing_characters,[]);assert.equal(result.shared_art_saved,true);
        output=[tool('draw_scene',{scene:{seg:'different',type:'custom',code:'def draw(c,t,p):\n    c.grad("sky","cream")\n    floor(c)'}},'fixed')];
      }else{
        assert.equal(savedArtwork.scenes.length,6);assert.equal(savedArtwork.art,originalArtwork.art);assert.equal(planWrites,1);
        // No paid drawing or production: stop this isolated dispatcher test after repair.
        return Response.json({error:{message:'intentional mock completion'}},{status:400});
      }
      return Response.json({id:'resp_revision_'+calls,status:'completed',output,usage:{input_tokens:10,output_tokens:10}});
    }catch(error){fetchError=error;return Response.json({error:{message:'mock assertion failed'}},{status:400});}
  };
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{
    registerStudio(new Hono(),pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('must not produce')},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    await done;if(fetchError)throw fetchError;assert.equal(calls,4);assert.equal(status,'failed');assert.equal(savedArtwork.scenes.length,6);
  }finally{clearTimeout(timeout);globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;}
});
