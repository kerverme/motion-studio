// Run with Playwright installed and PLAYWRIGHT_BROWSERS_PATH pointing to Firefox.
// Every API is mocked: these tests never generate provider media or submit a real job.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {firefox}=require('playwright');
const html=fs.readFileSync(path.join(__dirname,'../src/ui.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
const code=script.slice(0,script.lastIndexOf('\nstart();'));
const fixture={id:'classic-test',status:'ready',model:'gpt-6.1-sol',reasoning:'high',draft:{title_th:'คนชื่อกร ใครจ่ายบิล?'},storyboard:{script:[{id:'one',text:'คนชื่อกร กินข้าวด้วยกัน'}]},creative:{engine:'classic',settings:{mode:'auto',locked:false,max_usd:3},selection:{selected:{id:'rubber-hose',score:.9,reasons:['เหมาะกับเรื่อง'],confidence:.9},alternatives:[],low_confidence:false,plan:{identity:{palette:['#123456','#abcdef'],direction:'การ์ตูนเรื่องเดียวกัน'},scenes:[{seg:'one',objective:'เปิดเรื่อง',composition:'สามคนนั่งโต๊ะ',camera:'ภาพกว้าง',location:'ร้านอาหาร',characters:['กร'],events:[{action:'ยกมือ'}],sound:{decision:'effects',reason:'เสียงบิล',cues:[{id:'tap',word:'กร',duration:.5,prompt:'short tap'}]}}]}}}};
const quote={revision:'revision-1',quote_hash:'quote-1',known_total_usd:0,unknown:['narration','sfx','compute'],planning_usage:{input_tokens:20,output_tokens:10},items:[{category:'planning',quantity:0,estimated_usd:0},{category:'narration',quantity:670,estimated_usd:null},{category:'sfx',quantity:4.5,estimated_usd:null},{category:'compute',quantity:1,estimated_usd:null}],classic_approval:{available:true,max_usd:3,allocations:{narration:1,sfx:1,compute:1},unknown_ack_required:true,style_ack_required:false}};
(async()=>{
 const browser=await firefox.launch({headless:true,env:{...process.env,MOZ_DISABLE_CONTENT_SANDBOX:'1'}}),results=[];
 async function test(name,fn){const context=await browser.newContext({viewport:{width:1200,height:900}});await context.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}):r.abort());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));try{await page.goto('https://studio.test/');await page.setContent('<!doctype html><html><head><style>'+html.match(/<style>([\s\S]*?)<\/style>/)[1]+'</style></head><body><div id="root"></div><div id="test-target"></div></body></html>');await page.addScriptTag({content:code});await page.evaluate(({fixture,quote})=>{window.fixture=fixture;window.quote=quote;window.calls=[];window.opened=[];window.estimateCount=0;window.approvalCount=0;api=async(path,opts={})=>{calls.push({path,method:opts.method||'GET',body:opts.body?JSON.parse(opts.body):undefined});if(path.endsWith('/estimate')){estimateCount++;return structuredClone(quote);}if(path.endsWith('/approve')){approvalCount++;return {id:'one-job'};}if(path.endsWith('/capabilities'))return {styles:[]};return {};};window.openStudioDraft=openDraft;openDraft=id=>opened.push(id);load=async()=>{};}, {fixture,quote});await fn(page);assert.deepEqual(errors,[]);results.push(name);console.log('PASS '+name);}finally{await context.close();}}
 try{
 await test('Classic opens directly with a summary, no visible fields, and one duplicate-safe confirmation',async p=>{
  await p.evaluate(()=>creativeDraftView(document.getElementById('test-target'),fixture,async()=>{}));const target=p.locator('#test-target');
  assert.equal(await target.locator('input:visible,textarea:visible,select:visible').count(),0);assert.equal(await target.locator('input[type=checkbox]').count(),0);
  assert.equal(await target.getByText(/วงเงินอนุมัติในระบบ 3.00 USD/).count(),1);assert.match(await target.textContent(),/ไม่ใช่ราคาที่รับประกัน/);assert.match(await target.textContent(),/670/);assert.match(await target.textContent(),/ไม่เผยแพร่อัตโนมัติ/);
  assert.equal((await p.evaluate(()=>calls)).filter(x=>x.method!=='GET').length,0);
  await p.evaluate(()=>{const old=api;api=async(path,opts)=>{if(path.endsWith('/approve')){await new Promise(r=>window.releaseApproval=r);}return old(path,opts);};});
  await target.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).click();await p.evaluate(()=>{document.querySelector('#test-target .btn.primary').click();});assert.equal(await target.getByRole('button',{name:'กำลังส่งผลิต…'}).isDisabled(),true);await p.evaluate(()=>releaseApproval());await p.waitForFunction(()=>opened.length===1);
  const calls=await p.evaluate(()=>window.calls.filter(x=>x.path.endsWith('/approve')));assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{revision:'revision-1',quote_hash:'quote-1',confirm:true});
 });
 await test('Unknown and uncertain-style disclosures remain visible without acknowledgment checkboxes',async p=>{
  await p.evaluate(()=>{quote.classic_approval.style_ack_required=true;return classicCostDialog(document.getElementById('test-target'),'classic-test');});
  assert.match(await p.locator('#test-target').textContent(),/AI ยังไม่มั่นใจ/);assert.equal(await p.locator('#test-target input').count(),0);assert.equal(await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).isEnabled(),true);
 });
 await test('Quote load error can be retried without submitting production',async p=>{
  await p.evaluate(()=>{const old=api;let fail=true;api=async(path,opts)=>{if(path.endsWith('/estimate')&&fail){fail=false;throw Error('temporary failure');}return old(path,opts);};return classicCostDialog(document.getElementById('test-target'),'classic-test');});
  await p.getByRole('button',{name:'โหลดรายการผลิตอีกครั้ง'}).click();await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).waitFor();assert.equal((await p.evaluate(()=>calls)).filter(x=>x.method==='POST').length,0);
 });
 await test('Lost approval response retries the same revision rather than creating a new request',async p=>{
  await p.evaluate(()=>{const old=api;let fail=true;api=async(path,opts)=>{const result=await old(path,opts);if(path.endsWith('/approve')&&fail){fail=false;throw TypeError('network failed');}return result;};return classicCostDialog(document.getElementById('test-target'),'classic-test');});
  await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).click();await p.getByText(/ระบบจะตรวจงานเดิม/).waitFor();await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).click();await p.waitForFunction(()=>opened.length===1);const calls=await p.evaluate(()=>window.calls.filter(x=>x.method==='POST'));assert.equal(calls.length,2);assert.deepEqual(calls[0].body,calls[1].body);
 });
 await test('A changed quote is shown for confirmation again without automatic resubmission',async p=>{
  await p.evaluate(()=>{const old=api;let fail=true;api=async(path,opts)=>{if(path.endsWith('/approve')&&fail){fail=false;await old(path,opts);quote.revision='revision-2';quote.quote_hash='quote-2';quote.classic_approval.max_usd=4;const e=Error('quote changed');e.status=409;throw e;}return old(path,opts);};return classicCostDialog(document.getElementById('test-target'),'classic-test');});
  await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).click();await p.getByText(/วงเงินอนุมัติในระบบ 4.00 USD/).waitFor();assert.equal(await p.evaluate(()=>approvalCount),1);await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).click();await p.waitForFunction(()=>opened.length===1);const body=await p.evaluate(()=>calls.filter(x=>x.path.endsWith('/approve')).at(-1).body);assert.equal(body.revision,'revision-2');
 });
 await test('Insufficient budget or missing Classic recommendation cannot trigger approval',async p=>{
  await p.evaluate(()=>{quote.classic_approval.available=false;quote.classic_approval.reason='วงเงินที่บันทึกไว้ไม่พอ';return classicCostDialog(document.getElementById('test-target'),'classic-test');});assert.equal(await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).isDisabled(),true);assert.match(await p.locator('#test-target').textContent(),/วงเงินที่บันทึกไว้ไม่พอ/);await p.evaluate(()=>document.querySelector('#test-target button').click());assert.equal(await p.evaluate(()=>approvalCount),0);
  await p.evaluate(()=>{delete quote.classic_approval;return classicCostDialog(document.getElementById('test-target'),'classic-test');});assert.equal(await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).isDisabled(),true);
 });
 await test('Submitted Classic draft shows existing job status and never offers another production approval',async p=>{
  await p.evaluate(()=>{fixture.status='submitted';fixture.job_id='saved-job';const old=api;api=async(path,opts)=>path.endsWith('/jobs/saved-job')?{status:'GENERATING_AUDIO',progress:.2,stage:'กำลังสร้างเสียง'}:old(path,opts);return creativeDraftView(document.getElementById('test-target'),fixture,async()=>{});});assert.equal(await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).count(),0);assert.match(await p.locator('#test-target').textContent(),/กำลังสร้างเสียง/);assert.equal(await p.evaluate(()=>estimateCount),0);
 });
 await test('Terminal Classic job statuses override a stale rendering stage',async p=>{
  for(const [status,message] of [['CANCELLED','ยกเลิกการผลิตแล้ว'],['FAILED','ผลิตยังไม่สำเร็จ'],['READY_TO_POST','คลิปพร้อมใช้']]){
   await p.evaluate(status=>{fixture.status='submitted';fixture.job_id='saved-job';api=async()=>({status,stage:'RENDERING',progress:1,error:null});return creativeDraftView(document.getElementById('test-target'),fixture,async()=>{});},status);
   const text=await p.locator('#test-target').textContent();assert.ok(text.includes(message),text);assert.ok(!text.includes('กำลังประกอบวิดีโอ'),text);assert.equal(await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).count(),0);
  }
 });
 await test('Recent drafts and polling distinguish a real production job from missing or terminal jobs',async p=>{
  await p.clock.install();
  await p.evaluate(()=>{
   frame();STYLE_LIST=[];MUSIC_LIST=[];
   const st={llm:true,web_search:true,models:[],reasoning_levels:[],formats:{},daily_limit:20,drafts_today:0,max_credits:4500};
   const make=(id,job_status,job_id)=>({id,topic:id,status:'submitted',job_id,job_status,created_at:new Date().toISOString()});
   const missing=make('ร่างเก่า',null,null),cancel=make('งานที่ยกเลิก','CANCELLED','job-1');
   studio(st,[missing,cancel,make('สร้างคลิปเสร็จ','READY_TO_POST','job-2'),make('งานล้มเหลว','FAILED','job-3')]);
   window.busyWithoutJobs=S.studioBusy;
   window.activeJob=inProgress(make('เรนเดอร์','RENDERING','job-4'));
   window.statusReads=0;
   const previous=api;api=async(path,...args)=>{if(path.endsWith('/drafts/'+missing.id)){statusReads++;return missing;}return previous(path,...args);};
   openDraft=window.openStudioDraft;
  });
  const list=p.locator('.drafts');
  assert.equal(await list.locator('.pulse').count(),0);
  assert.equal(await p.evaluate(()=>busyWithoutJobs),false);assert.equal(await p.evaluate(()=>activeJob),true);
  assert.match(await list.textContent(),/ยกเลิกการผลิตแล้ว/);
  await list.getByRole('button',{name:/^ร่างเก่า/}).click();
  await p.locator('.drawer').getByRole('heading',{name:'ไม่พบงานผลิตที่เชื่อมกับร่าง',exact:true}).last().waitFor();
  await p.clock.runFor(10000);
  assert.equal(await p.evaluate(()=>statusReads),1);
  assert.equal(await p.locator('.drawer').getByRole('button',{name:'ดูความคืบหน้า'}).count(),0);
 });
 await test('Composer keeps voice and engine choices but does not carry Lemo budget/style into Classic',async p=>{
  await p.evaluate(()=>{frame();STYLE_LIST=[];MUSIC_LIST=[];const old=api;api=async(path,opts)=>path.endsWith('/drafts')&&opts?.method==='POST'?(window.created=JSON.parse(opts.body),{id:'created'}):old(path,opts);const st={llm:true,web_search:true,creative:{enabled:true,styles:[{id:'rubber-hose',name:'Rubber Hose'}]},models:[{id:'gpt-6.1-sol',label:'Sol'}],model:'gpt-6.1-sol',reasoning_levels:[],formats:{},daily_limit:20,drafts_today:1,max_credits:4500};studio(st,[]);});
  assert.equal(await p.getByLabel('งบสูงสุด USD',{exact:true}).isVisible(),false);await p.getByLabel('Rendering engine').selectOption('lemo');assert.equal(await p.getByLabel('งบสูงสุด USD',{exact:true}).isVisible(),true);await p.getByLabel('งบสูงสุด USD',{exact:true}).fill('0');await p.getByLabel('การเลือกสไตล์',{exact:true}).selectOption('manual');await p.getByLabel('โมเดลเสียง',{exact:true}).selectOption('eleven_v3');await p.getByLabel('Rendering engine').selectOption('classic');assert.equal(await p.getByLabel('งบสูงสุด USD',{exact:true}).isVisible(),false);await p.getByLabel('หัวข้อเรื่อง',{exact:true}).fill('คนชื่อกร ใครจ่ายบิล');await p.getByRole('button',{name:'เริ่มค้นและเขียน',exact:true}).click();await p.waitForFunction(()=>window.created);assert.deepEqual(await p.evaluate(()=>created.creative),{engine:'classic',tts_model:'eleven_v3',sfx_model:'eleven_text_to_sound_v3',mode:'auto'});
 });
 await test('New and returning owners see 6.2 Sol high, explicit choices persist, unavailable defaults require selection',async p=>{
  const values=await p.evaluate(()=>{
    const models=['gpt-6.2-sol','gpt-6.1-sol','gpt-7.1-nova'].map(id=>({id,label:generationModelLabel(id)}));
    const controls=(ids=models)=>brainControls(ids,'gpt-6.2-sol',['low','medium','high'],'high',{source:'openai'},'Model','Effort');
    const values=c=>[c.modelSel.value,c.effSel.value];
    const fresh=values(controls());localStorage.setItem('ms.ai',JSON.stringify({model:'gpt-6.1-sol',reasoning:'high'}));
    const migrated=controls(), upgraded=values(migrated);migrated.modelSel.value='gpt-7.1-nova';migrated.effSel.value='low';migrated.effSel.dispatchEvent(new Event('change'));
    const manual=values(controls());localStorage.removeItem('ms.ai');
    return {fresh,upgraded,manual,unavailable:values(controls(models.slice(1))),label:clipDisplayTitle({generation_model:'gpt-7.1-nova',title:'คลิป'})};
  });
  assert.deepEqual(values,{fresh:['gpt-6.2-sol','high'],upgraded:['gpt-6.2-sol','high'],manual:['gpt-7.1-nova','low'],unavailable:['','high'],label:'[GPT-7.1 Nova] คลิป'});
 });
 await test('An open model picker refreshes the account list without resetting the story or a manual selection',async p=>{
  const result=await p.evaluate(async()=>{
    let release;const gate=new Promise(resolve=>release=resolve);const calls=[];
    api=async(path)=>{calls.push(path);await gate;return {models:[{id:'gpt-6.2-sol',label:'Sol'},{id:'gpt-6.1-terra',label:'Terra'},{id:'gpt-7.1-nova',label:'Nova'}],model_catalog:{source:'openai',checked_at:new Date().toISOString()}};};
    const controls=brainControls([{id:'gpt-6.2-sol',label:'Sol'},{id:'gpt-6.1-terra',label:'Terra'}],'gpt-6.2-sol',['low','high'],'high',{source:'openai',checked_at:'2020-01-01T00:00:00Z'},'Model','Effort');
    const topic=h('textarea',{});topic.value='เรื่องที่ยังเขียนไม่จบ';document.body.append(topic,controls.modelSel);
    const requests=[refreshVisibleBrains(),refreshVisibleBrains()];controls.modelSel.value='gpt-6.1-terra';controls.modelSel.dispatchEvent(new Event('change'));
    release();await Promise.all(requests);return {topic:topic.value,model:controls.modelSel.value,ids:[...controls.modelSel.options].map(o=>o.value),calls};
  });
  assert.deepEqual(result,{topic:'เรื่องที่ยังเขียนไม่จบ',model:'gpt-6.1-terra',ids:['gpt-6.2-sol','gpt-6.1-terra','gpt-7.1-nova'],calls:['/app/api/studio/openai-models']});
 });
 await test('Trend search uses its own OpenAI picker, refreshes both lists and submits the selected model once',async p=>{
  await p.setViewportSize({width:390,height:844});
  await p.evaluate(()=>{
   frame();STYLE_LIST=[];MUSIC_LIST=[];
   const models=['gpt-6.2-sol','gpt-6.1-terra','gpt-6.2-astra'].map(id=>({id,label:generationModelLabel(id)}));
   const catalog={source:'openai',checked_at:new Date().toISOString()};
   const st={provider:'openai',llm:true,web_search:true,model:'gpt-6.2-sol',models,model_catalog:catalog,reasoning:'high',reasoning_levels:['low','medium','high'],formats:{},daily_limit:20,drafts_today:0,max_credits:4500,trend_research:{enabled:true,research_model:'gpt-6.1-terra',models,model_catalog:catalog}};
   window.reopenTrendScreen=()=>studio(st,[]);
   const previous=api;window.searchPosts=[];window.modelRefreshes=0;
   api=async(path,opts={})=>{
    if(path==='/app/api/studio/openai-models?refresh=1'){modelRefreshes++;return {models:[...models,{id:'gpt-7-sol',label:'GPT-7 Sol'}],model_catalog:catalog};}
    if(path.includes('/trends?'))return {runs:[],trends:[{title:'คนละคำค้น',score:93}]};
    if(path.endsWith('/trends/refresh')){const req=JSON.parse(opts.body);searchPosts.push(req);return {id:'saved-job',status:'queued',model:req.model};}
    if(path.endsWith('/runs/saved-job'))return {id:'saved-job',status:'done',request:searchPosts[0],eligible_count:0};
    if(path.includes('/trends/runs/'))throw Object.assign(Error('missing'),{status:404});
    return previous(path,opts);
   };
   reopenTrendScreen();
  });
  const writing=p.getByLabel('โมเดล',{exact:true}),research=p.getByRole('region',{name:'ค้นหาเทรนด์',exact:true});
  const model=research.getByLabel('สมองค้นหาเทรนด์',{exact:true}),query=research.getByLabel('หัวข้อค้นหาเทรนด์',{exact:true});
  assert.equal(await writing.inputValue(),'gpt-6.2-sol');assert.equal(await model.inputValue(),'gpt-6.1-terra');
  await writing.selectOption('gpt-6.2-astra');await query.fill('แมวไทย');await model.selectOption('gpt-6.2-sol');
  await research.getByRole('button',{name:'อัปเดตรายชื่อโมเดล'}).click();
  await p.waitForFunction(()=>document.querySelector('[aria-label="สมองค้นหาเทรนด์"] option[value="gpt-7-sol"]'));
  assert.equal(await writing.locator('option[value="gpt-7-sol"]').count(),1);
  assert.equal(await writing.inputValue(),'gpt-6.2-astra');assert.equal(await model.inputValue(),'gpt-6.2-sol');assert.equal(await query.inputValue(),'แมวไทย');
  const button=research.getByRole('button',{name:'ค้นหาเทรนด์',exact:true});
  await button.evaluate(b=>{b.click();b.click();});
  await p.waitForFunction(()=>searchPosts.length===1);
  await research.getByText(/ผลการค้นหาด้วย GPT-6.2 Sol/).waitFor();
  assert.equal(await research.getByText(/คนละคำค้น/).count(),0);
  const posts=await p.evaluate(()=>searchPosts);assert.equal(posts.length,1);assert.equal(posts[0].model,'gpt-6.2-sol');assert.equal(posts[0].query,'แมวไทย');
  assert.equal(await p.evaluate(()=>modelRefreshes),1);
  const sizes=await research.evaluate(e=>({width:e.clientWidth,content:e.scrollWidth}));assert.ok(sizes.content<=sizes.width+1,JSON.stringify(sizes));
  await p.evaluate(()=>reopenTrendScreen());
  assert.equal(await writing.inputValue(),'gpt-6.2-astra');assert.equal(await model.inputValue(),'gpt-6.2-sol');
  await p.evaluate(()=>localStorage.setItem('ms.trend_brain',JSON.stringify({version:2,model:'gpt-retired'})));
  await p.evaluate(()=>reopenTrendScreen());assert.equal(await model.inputValue(),'');assert.equal(await button.isDisabled(),true);
 });
 await test('a timed-out research stage resumes the saved job and shows progress without submitting another search',async p=>{
  await p.evaluate(()=>{
   frame();STYLE_LIST=[];MUSIC_LIST=[];const models=[{id:'gpt-6.2-sol',label:'GPT-6.2 Sol'}];
   const saved={id:'stored',request:{query:'เรื่องใกล้ตัว',model:models[0].id,platform:'both'},error:'OpenAI เกินเวลารอ',status:'failed',can_resume_openai:true,firecrawl:{actual:4}};
   window.resumePosts=[];
   api=async(path,opts={})=>{
    if(opts.method==='POST'){resumePosts.push({path,body:JSON.parse(opts.body)});saved.status='queued';saved.error=null;saved.can_resume_openai=false;saved.details={openai_stage:'score'};return {id:saved.id};}
    if(path.includes('/trends?'))return {runs:[structuredClone(saved)],trends:[]};
    if(path.endsWith('/runs/stored'))return structuredClone(saved);
    return {};
   };
   window.finishResearch=()=>{saved.status='partial';saved.details={model:models[0].id};};
   studio({provider:'openai',llm:true,web_search:true,model:models[0].id,models,reasoning:'high',reasoning_levels:['high'],formats:{},daily_limit:20,drafts_today:0,max_credits:4500,trend_research:{enabled:true,research_model:models[0].id,models}},[]);
  });
  const region=p.getByRole('region',{name:'ค้นหาเทรนด์',exact:true});
  await region.getByRole('button',{name:'ทำงานต่อจากข้อมูลเดิม'}).evaluate(b=>{b.click();b.click();});
  await region.getByText(/OpenAI กำลังวิเคราะห์ข้อมูลโซเชียล/).waitFor();await p.evaluate(()=>finishResearch());
  await region.getByText(/หลักฐานยังไม่ครบ/).waitFor();
  assert.deepEqual(await p.evaluate(()=>resumePosts),[{path:'/app/api/studio/trends/runs/stored/retry',body:{replace_cancelled:true}}]);
  assert.equal(await region.getByText('OpenAI เกินเวลารอ').count(),0);
 });
 await test('a fresh tab follows an existing background search to a terminal result using only reads',async p=>{
  await p.evaluate(()=>{
   frame();STYLE_LIST=[];MUSIC_LIST=[];window.trendReads=0;window.writes=[];
   const m={id:'gpt-6.2-sol',label:'GPT-6.2 Sol'};
   api=async(path,opts={})=>{
    if(opts.method==='POST')writes.push(path);
    if(path.includes('/trends?')){
     const done=++trendReads>1;
     return {runs:[{id:'existing',created_at:new Date().toISOString(),finished_at:done?new Date().toISOString():null,status:done?'partial':'queued',request:{model:m.id},firecrawl:{actual:4},eligible_count:0,evidence_count:55,details:done?{received_count:55,web_sources:[]}:{openai_stage:'score'}}],trends:[]};
    }return {};
   };
   studio({llm:true,provider:'openai',model:m.id,models:[m],reasoning:'high',reasoning_levels:['high'],formats:{},trend_research:{enabled:true,research_model:m.id,models:[m]}},[]);
  });
  const region=p.getByRole('region',{name:'ค้นหาเทรนด์',exact:true});
  await region.getByText(/OpenAI กำลังวิเคราะห์ข้อมูลโซเชียล/).waitFor();
  await region.getByText(/ตรวจโพสต์ย้อนหลัง 7 วัน 55 โพสต์/).waitFor();
  assert.deepEqual(await p.evaluate(()=>({reads:trendReads,writes})),{reads:2,writes:[]});
 });
 await test('Classic confirmation fits a narrow mobile drawer without horizontal overflow',async p=>{
  await p.setViewportSize({width:390,height:844});await p.evaluate(()=>{const target=document.getElementById('test-target');target.className='drawer';target.style.padding='20px';return creativeDraftView(target,fixture,async()=>{});});
  const sizes=await p.locator('#test-target').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify(sizes));assert.equal(await p.locator('#test-target input:visible,#test-target textarea:visible,#test-target select:visible').count(),0);
 });
 await test('Lemo opens with bounded production confirmation and optional storyboard editing',async p=>{
  await p.evaluate(()=>{
   fixture.creative.engine='lemo';quote.lemo_approval=quote.classic_approval;quote.gates={enabled:true};
   return creativeDraftView(document.getElementById('test-target'),fixture,async()=>{});
  });
  assert.equal(await p.locator('#test-target input:visible,textarea:visible,select:visible').count(),0);
  assert.ok(await p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).isEnabled());
  assert.equal(await p.evaluate(()=>estimateCount),1);
  await p.locator('summary').filter({hasText:'ปรับบท สไตล์ และรายละเอียดฉาก'}).click();
  assert.ok(await p.getByLabel('สไตล์หลัก',{exact:true}).isVisible());
  assert.ok(await p.getByLabel('บทฉาก one',{exact:true}).isVisible());
 });
 await test('Lemo with disabled production gates shows the draft without allowing a paid submission',async p=>{
  await p.evaluate(()=>{
   fixture.creative.engine='lemo';quote.lemo_approval=quote.classic_approval;quote.gates={enabled:false,blockers:['LEMO_ENABLED']};
   return creativeDraftView(document.getElementById('test-target'),fixture,async()=>{});
  });
  const confirm=p.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true});
  assert.ok(await p.getByRole('alert').filter({hasText:'ยังไม่เปิดให้ผลิตด้วย Lemo'}).isVisible());
  assert.ok(await confirm.isDisabled());
  await confirm.evaluate(button=>button.click());
  assert.equal(await p.evaluate(()=>approvalCount),0);
 });
 await test('Legacy research draft opens without spending and resumes the same receipt exactly once per click',async p=>{
  await p.evaluate(()=>{
   window.resumeWrites=[];
   const d={...fixture,topic:'ทดสอบร่างเก่า',status:'failed',draft:null,storyboard:null,creative:null,legacy_resume:{turn:4,response_id:'resp_main4'},log:[],usage:{turns:3}};
   api=async(path,opts={})=>{
    if(!opts.method && path.endsWith('/drafts/'+d.id)) return d;
    if(path.endsWith('/resume') && opts.method==='POST'){
     resumeWrites.push({path,body:JSON.parse(opts.body)});
     await new Promise(resolve=>{window.answerResume=resolve;});
     if(resumeWrites.length===1)throw Error('ยืนยันจุดที่ร่างหยุดไม่ได้');
     d.status='queued';return {id:d.id,status:d.status};
    }
    throw Error('Unexpected path '+path);
   };
   openStudioDraft(d.id);
  });
  const drawer=p.getByRole('dialog'),btn=drawer.getByRole('button',{name:'ทำร่างเดิมต่อ',exact:true});
  await btn.waitFor();
  assert.match(await drawer.textContent(),/อาจใช้เครดิตเพิ่ม/);
  assert.deepEqual(await p.evaluate(()=>resumeWrites),[]);
  await btn.evaluate(el=>{el.click();el.click();});
  assert.ok(await btn.isDisabled());
  const expected={path:'/app/api/studio/drafts/classic-test/resume',body:{response_id:'resp_main4',confirm:true}};
  assert.deepEqual(await p.evaluate(()=>resumeWrites),[expected]);
  await p.evaluate(()=>answerResume());
  await drawer.getByRole('alert').filter({hasText:'ยืนยันจุดที่ร่างหยุดไม่ได้'}).waitFor();
  assert.ok(await btn.isEnabled());
  await btn.click();await p.evaluate(()=>answerResume());
  await btn.waitFor({state:'detached'});
  assert.equal(await drawer.getByRole('button',{name:'ลองใหม่'}).count(),0);
  assert.deepEqual(await p.evaluate(()=>resumeWrites),[expected,expected]);
 });
 await test('A scrolled Lemo research log returns to the production confirmation when the draft is ready',async p=>{
  await p.setViewportSize({width:390,height:600});
  await p.clock.install();
  await p.evaluate(()=>{
   fixture.creative.engine='lemo';quote.lemo_approval=quote.classic_approval;quote.gates={enabled:true};
   let reads=0;
   const previous=api;
   api=async(path,opts)=>{
    if(path.endsWith('/drafts/'+fixture.id)&&++reads===1){
     const log=Array.from({length:14},(_,i)=>({at:new Date().toISOString(),msg:'กำลังค้นข้อมูลรอบ '+i+' · '+('รายละเอียดการอ่านข้อมูล '.repeat(8))}));
     return {...fixture,status:'researching',log};
    }
    return path.endsWith('/drafts/'+fixture.id)?fixture:previous(path,opts);
   };
   window.openStudioDraft(fixture.id);
  });
  const drawer=p.getByRole('dialog');
  await drawer.getByRole('heading',{name:'กำลังค้นข้อมูล'}).waitFor();
  assert.ok(await drawer.evaluate(panel=>{panel.scrollTop=panel.scrollHeight;return panel.scrollTop;})>0);
  await p.clock.runFor(4100);
  await drawer.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true}).waitFor();
  assert.equal(await drawer.evaluate(panel=>panel.scrollTop),0);
  assert.equal(await p.evaluate(()=>approvalCount),0);
 });
 console.log(JSON.stringify({passed:results.length,tests:results,realBrowser:true,mockedProviders:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
