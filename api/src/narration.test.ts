import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {Hono} from 'hono';
import {parseNarration,narrationPrompt,parseSourceText,sourceMaterialBlock,readSourceMaterial,SOURCE_TEXT_LIMIT} from './narration.js';
process.env.MOTION_LLM_PROVIDER='openai';process.env.OPENAI_API_KEY='mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH='true';delete process.env.FIRECRAWL_API_KEY;
const {registerStudio}=await import('./studio.js');
const db=new PGlite();after(()=>db.close());

test('narration choices validate custom direction and preserve medical uncertainty independently of reading level',()=>{
  assert.deepEqual(parseNarration({}),{narration_style:'standard',narration_custom:''});
  assert.throws(()=>parseNarration({narration_style:'invented'}));
  assert.throws(()=>parseNarration({narration_style:'custom',narration_custom:' '}));
  assert.throws(()=>parseNarration({narration_style:'custom',narration_custom:'x'.repeat(1001)}));
  assert.deepEqual(parseNarration({narration_style:'custom',narration_custom:'  เล่าเป็นครูใจดี  '}),{narration_style:'custom',narration_custom:'เล่าเป็นครูใจดี'});
  assert.equal(parseNarration({narration_style:'child_10',narration_custom:'stale custom'}).narration_custom,'');
  const prompt=narrationPrompt(parseNarration({narration_style:'child_10'}));
  assert.match(prompt,/10-year-old/);assert.match(prompt,/not a claim that adult medical advice or drug doses apply to children/);
  assert.match(prompt,/unverified secondary material/);assert.match(prompt,/never convert correlation into causation/i);
  assert.match(prompt,/separately from visual style/);
});

test('complete source keeps exact boundaries and reader cannot stand in for a fetched URL',()=>{
  const source='  FIRST\n'+ 'ก'.repeat(30000)+'\nLAST https://unverified.example/research  ';
  assert.equal(parseSourceText(source),source);
  assert.ok(sourceMaterialBlock(source).includes(JSON.stringify(source)));
  const tail=readSourceMaterial(source,source.indexOf('LAST'),12000);
  assert.equal(tail.text,'LAST https://unverified.example/research  ');assert.equal(tail.verified,false);assert.equal(tail.has_more,false);
  assert.throws(()=>parseSourceText('a'.repeat(SOURCE_TEXT_LIMIT+1)));
  assert.equal(parseSourceText('a'.repeat(SOURCE_TEXT_LIMIT)).length,SOURCE_TEXT_LIMIT);
  assert.throws(()=>readSourceMaterial(source,-1,20));assert.throws(()=>readSourceMaterial(source,0,12001));
});

test('routes persist long source and narration, reject oversized input, and invalidate incompatible retry artwork',async()=>{
  const dir=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(file,dir),'utf8'));
  await db.exec(readFileSync(new URL('019_narration.sql',dir),'utf8'));
  const pool={query:async(sql:string,args:any[]=[])=>sql.startsWith("SELECT id FROM drafts WHERE status='queued'")?{rows:[]}:db.query(sql,args)};
  const nativeTimeout=globalThis.setTimeout;
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{
    const app=new Hono();registerStudio(app,pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('must not produce')},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    const send=(path:string,body:any,key:string)=>app.request(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
    const path='/app/api/studio/drafts';
    const source='  source start\n'+'เนื้อหาอ้างอิง '.repeat(3000)+'\nSOURCE END  ';
    assert.ok(source.length>20000);
    const body={topic:'ร่างจากบทความยาว',story_mode:'general',source_text:source,model:'gpt-6.1-sol',narration_style:'custom',narration_custom:'เล่าเป็นครูใจดี โดยใช้คำง่าย',auto_produce:false,characters:[]};
    const created=await send(path,body,'narration-create-001');assert.equal(created.status,201,await created.clone().text());const {id}=await created.json();
    const detail:any=await (await app.request(path+'/'+id)).json();
    assert.equal(detail.source_text,source);assert.equal(detail.source_text_characters,source.length);assert.equal(detail.narration_style,'custom');assert.equal(detail.narration_custom,body.narration_custom);assert.equal(detail.model,body.model);
    assert.equal((await send(path,body,'narration-create-001')).status,201);
    assert.equal((await send(path,{...body,narration_style:'child_10'},'narration-create-001')).status,409);
    assert.equal((await send(path,{...body,source_text:'x'.repeat(SOURCE_TEXT_LIMIT+1)},'narration-too-long')).status,422);
    assert.equal((await send(path,{...body,narration_custom:''},'narration-empty-custom')).status,422);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM drafts')).rows[0].n,1,'invalid input creates no draft');
    const plan={story_mode:'general',script:[],shots:[]}, art={cast:[],scenes:[],art:'saved'};
    await db.query("UPDATE drafts SET status='failed',storyboard=$2,artwork=$3 WHERE id=$1",[id,JSON.stringify(plan),JSON.stringify(art)]);
    const retried=await send(path+'/'+id+'/rewrite',{},'narration-retry-001');assert.equal(retried.status,201);const childId=(await retried.json()).id;
    const child:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[childId])).rows[0];
    assert.equal(child.source_text,source);assert.equal(child.narration_style,'custom');assert.equal(child.narration_custom,body.narration_custom);assert.deepEqual(child.storyboard,plan);assert.deepEqual(child.artwork,art);
    await db.query("UPDATE drafts SET status='failed' WHERE id=$1",[childId]);
    const changed=await send(path+'/'+childId+'/rewrite',{narration_style:'child_10'},'narration-change-001');assert.equal(changed.status,201);const changedId=(await changed.json()).id;
    const fresh:any=(await db.query('SELECT * FROM drafts WHERE id=$1',[changedId])).rows[0];
    assert.equal(fresh.narration_style,'child_10');assert.equal(fresh.narration_custom,'');assert.equal(fresh.source_text,source);assert.equal(fresh.storyboard,null);assert.equal(fresh.artwork,null);
    const status:any=await (await app.request('/app/api/studio/status')).json();assert.equal(status.source_text_limit,100000);assert.equal(status.narration_previews,true);assert.ok(status.narration_styles.some((s:any)=>s.id==='child_10'));
  }finally{globalThis.setTimeout=nativeTimeout;}
});

test('generation plans from the full source, compacts only after saving, and rereads exact tail without verifying it',async()=>{
  const source='FIRST SOURCE\n'+'unverified material '.repeat(2200)+'\nLAST SOURCE https://unverified.example/claim';
  const script=['open','first','second','end'].map((id,i)=>({id,text:'สมมติว่าแก้วน้ำหนึ่งใบ กำลังเล่าเรื่องของตัวเอง',beat:i===0?'hook':i===3?'cta':'info'}));
  const plan={story_mode:'general',script,shots:script.map(s=>({seg:s.id,visual:'A transparent glass of water on a table',action:'Light crosses the glass',camera:'Medium shot',characters:[]})),character_notes:'No people.'};
  let status='queued',calls=0,planSaved=false,lastResearch:any[]=[],fetchError:unknown;
  let resolveDone!:()=>void;const done=new Promise<void>(r=>{resolveDone=r;});
  const row={id:'10000000-0000-0000-0000-000000000089',topic:'แก้วน้ำเล่าเรื่อง',story_mode:'general',source_text:source,narration_style:'child_10',narration_custom:'',model:'gpt-6.1-sol',reasoning:'medium',characters:[],style:'classic',auto_produce:false};
  const pool={query:async(sql:string,args:any[]=[])=>{
    if(sql.includes("WHERE status IN ('researching','writing')"))return{rows:[]};
    if(sql.includes("SELECT id FROM drafts WHERE status='queued'"))return{rows:status==='queued'?[{id:row.id}]:[]};
    if(sql.startsWith('SELECT * FROM drafts WHERE id='))return{rows:[{...row,status}]};
    if(sql.startsWith('SELECT id, draft FROM drafts'))return{rows:[]};
    if(sql.startsWith("UPDATE drafts SET status='researching'"))status='researching';
    if(sql.startsWith('UPDATE drafts SET storyboard=')){planSaved=true;status='writing';}
    if(sql.startsWith('UPDATE drafts SET usage='))lastResearch=JSON.parse(args[2]);
    if(sql.startsWith("UPDATE drafts SET status='failed'")){status='failed';resolveDone();}
    return{rows:[],rowCount:1};
  }};
  const nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout;
  const timeout=nativeTimeout(resolveDone,5000);
  const tool=(name:string,input:unknown,id:string)=>({type:'function_call',name,call_id:id,arguments:JSON.stringify(input)});
  globalThis.fetch=async(_url,init)=>{
    try{
      calls++;const body=JSON.parse(String(init?.body));
      assert.equal(body.model,row.model);assert.match(body.instructions,/10-year-old/);assert.match(body.instructions,/unverified secondary material/);
      const first=body.input[0].content;
      assert.ok(body.tools.some((t:any)=>t.name==='read_source_material'));
      let output:any[];
      if(calls===1){assert.ok(first.includes(JSON.stringify(source)));output=[tool('plan_story',{bad:true},'invalid')];}
      else if(calls===2){assert.equal(planSaved,false);assert.ok(first.includes(JSON.stringify(source)));output=[{type:'web_search_call',status:'completed',action:{type:'open_page',url:'https://verified.example/source'}},tool('plan_story',plan,'plan')];}
      else if(calls===3){assert.equal(planSaved,true);assert.equal(first.includes('FIRST SOURCE'),false);assert.equal(first.includes('LAST SOURCE'),false);assert.ok(first.includes('remains stored in full'));assert.ok(JSON.stringify(body.input).includes('https://verified.example/source'));output=[tool('read_source_material',{offset:source.indexOf('LAST SOURCE'),length:12000},'tail')];}
      else{
        const result=body.input.find((i:any)=>i.type==='function_call_output'&&i.call_id==='tail');const read=JSON.parse(result.output);
        assert.equal(read.text,source.slice(source.indexOf('LAST SOURCE')));assert.equal(read.verified,false);
        assert.ok(!JSON.stringify(lastResearch).includes('unverified.example'));assert.ok(JSON.stringify(lastResearch).includes('verified.example/source'));
        // End this isolated planning test without drawing, charging or producing a clip.
        return new Response(JSON.stringify({error:{message:'intentional end of mocked planning test'}}),{status:400});
      }
      return new Response(JSON.stringify({id:'resp_source_'+calls,status:'completed',output,usage:{input_tokens:10,output_tokens:10}}),{status:200});
    }catch(e){fetchError=e;return new Response(JSON.stringify({error:{message:'mock assertion failed'}}),{status:400});}
  };
  globalThis.setTimeout=((fn:any,ms?:number,...args:any[])=>nativeTimeout(ms===8000?()=>{}:fn,ms===8000?0:ms,...args)) as typeof setTimeout;
  try{
    registerStudio(new Hono(),pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('must not produce')},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    await done;if(fetchError)throw fetchError;assert.equal(calls,4);assert.equal(planSaved,true);assert.equal(status,'failed');
  }finally{clearTimeout(timeout);globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;}
});
