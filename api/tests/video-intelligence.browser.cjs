// Browser regressions exercise the served Studio scripts using local provider fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { firefox } = require('playwright');
const src = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const html = src('ui.html');
const app = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const cfg = {
  brains: ['gpt-6.2-sol'], default_brain: 'gpt-6.2-sol', reasoning_levels: ['high'],
  default_reasoning: 'high', narration_styles: [{id:'auto',label:'อัตโนมัติ'}],
  durations: [60,90,120], model_catalog: {}, openai_configured: true, usd_to_thb: 33, fx_source:'ECB', fx_date:'2026-11-23',
  voice_usd_per_1000_characters:0.08,voice_model:'eleven_v4',eleven_pricing:{usd_per_1000_characters:0.15,source:'https://elevenlabs.io/pricing/api'}, models:[{id:'legacy',label:'Legacy',resolutions:['720p']}],
};
const spec = {endpoint_id:'fal-ai/test',resolution:'720p',duration:5,edited_duration:4,quantity:1,
  prompt:'A leaf opening.',original_prompt:'A leaf opens',rank:1,reason:'Supports plant motion',audio:false,prompt_mode:'optimized'};
const shot = {id:'leaf',narration:'ใบไม้คลี่ออก',end_frame:'a green leaf in frame',visual_prompt:'Closeup of a real leaf gradually unfolding.',direction:{camera:'wide shot',actions:[]},production:spec};
const row = {id:'plan-test',status:'ready',request:{topic:'ใบไม้',duration:60,model:'gpt-6.2-sol',reasoning:'high',budget_usd:5,routing_mode:'best_value',engine_version:2},revision:1,plan:{title:'ใบไม้',visual_bible:'Green',synopsis:'เรื่องของใบไม้',shots:[shot],sources:[]}};
const arena = {refreshing:false,categories:[{category:'text-to-video',models:[
  {rank:1,name:'Available',elo:1020,provider:'Provider',fal:{available:true,category:'text-to-video',endpoint_id:'fal-ai/test',resolutions:['720p','1080p'],durations:[5,10],audio:true,price:{unit_price:0.07,currency:'USD',unit:'second'}}},
  {rank:2,name:'Unmapped',elo:null,fal:null}],stale:true,error:'snapshot retained',last_success_at:'2026-11-20T00:00:00Z'}]};
(async()=>{
 const browser=await firefox.launch({headless:true,env:{...process.env,MOZ_DISABLE_CONTENT_SANDBOX:'1'}});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}):r.abort());
  await page.goto('https://studio.test/');
  await page.setContent('<!doctype html><style>'+html.match(/<style>([\s\S]*?)<\/style>/)[1]+'</style><div id="root"></div>');
  await page.addScriptTag({content:app.slice(0,app.lastIndexOf('\nstart();'))});
  await page.addScriptTag({content:src('text-video-ui.js')});
  await page.evaluate(({cfg,arena,row})=>{
    window.calls=[];window.row=row;window.fixtureArena=arena;
    api=async(path,opts={})=>{
      const body=opts.body?JSON.parse(opts.body):null;calls.push({path,method:opts.method||'GET',body,key:opts.headers?.['idempotency-key']});
      if(path.endsWith('/arena/refresh')){fixtureArena.categories[0].stale=false;fixtureArena.categories[0].error=null;fixtureArena.categories[0].registry_partial=true;fixtureArena.categories[0].models[0].video_to_video_error='Source video metadata timed out';fixtureArena.categories[0].models[1].fal_error='Model schema temporarily unavailable';return fixtureArena;}
      if(path.endsWith('/arena'))return fixtureArena;
      if(path.endsWith('/plans')&&opts.method==='POST')return {id:row.id};
      if(path.endsWith('/plans'))return {plans:[row]};
      if(path.endsWith('/plan-test')&&opts.method==='PATCH'){row.revision++;row.plan=body.plan;return structuredClone(row);}
      if(path.endsWith('/plan-test'))return structuredClone(row);
      if(path.endsWith('/quote')){
        const s=row.plan.shots[0],p=s.production;
        return {id:'quote-'+row.revision,revision:row.revision,expires_at:new Date(Date.now()+90000).toISOString(),fal_usd:.40,eleven_usd:.02,qa_usd:.03,total_usd:.45,total_thb:14.85,usd_to_thb:33,remaining_budget_usd:4.55,
          generated_seconds:p.duration,edited_seconds:p.edited_duration,
          fal:[{scene_id:s.id,endpoint_id:p.endpoint_id,generation_seconds:p.duration,edited_seconds:p.edited_duration,resolution:p.resolution,estimated_usd:.4,quantity:1,payload:{prompt:p.prompt}}]};
      }
      if(path.endsWith('/produce')){await new Promise(r=>setTimeout(r,80));row.status='producing';row.job_status='NEW';row.job_id='job';return {job_id:'job'};}
      if(path.includes('/history'))return window.historyFixture||{job:{status:'NEW',stage:'Generating videos',created_at:new Date().toISOString()},events:[],scenes:[]};
      throw Error('Unmocked '+path);
    };
    frame();renderTextVideo(cfg,[row]);
  },{cfg,arena,row});
  const label=(s)=>page.getByLabel(s,{exact:true});
  const btn=(name)=>page.getByRole('button',{name,exact:true});
  assert.equal(await label('ความละเอียดที่ต้องการ').inputValue(),'720p');
  assert.equal(await label('งบผลิต USD').inputValue(),'5');
  assert.equal(await label('วิธีเลือกโมเดล').inputValue(),'best_value');
  await label('หัวข้อ Text to Video').fill('ใบไม้ทำงานอย่างไร');
  await page.getByText(/snapshot retained/).waitFor();
  await label('วิธีเลือกโมเดล').selectOption('manual');
  assert.equal(await label('เลือกโมเดลด้วยตัวเอง').locator('option',{hasText:'Unmapped'}).evaluate(el=>el.disabled),true);
  assert.equal(await label('เลือกโมเดลด้วยตัวเอง').locator('option',{hasText:'Available'}).evaluate(el=>el.disabled),true);
  await btn('รีเฟรชอันดับ').click();
  await page.waitForFunction(()=>calls.some(x=>x.path.endsWith('/arena/refresh')));
  await page.getByText(/อันดับ Arena อัปเดตแล้ว แต่ยังตรวจข้อมูล fal.ai ของบางรุ่นไม่ได้/).waitFor();
  await page.getByText('Unmapped',{exact:true}).click();
  await page.getByText(/Model schema temporarily unavailable/).waitFor();
  assert.ok(await btn('เลือก Unmapped').isDisabled());
  await page.getByText('Available',{exact:true}).click();
  await page.getByText(/Source video metadata timed out/).waitFor();
  assert.ok(await btn('เลือก Available').isEnabled());
  await btn('เลือก Available').click();
  assert.equal(await label('เลือกโมเดลด้วยตัวเอง').inputValue(),'fal-ai/test');
  console.log('PASS Partial fal metadata failure retains live ranks, shows per-route causes and leaves verified routes selectable');
  assert.equal(await label('หัวข้อ Text to Video').inputValue(),'ใบไม้ทำงานอย่างไร');
  assert.equal(await label('เลือกโมเดลด้วยตัวเอง').inputValue(),'fal-ai/test');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('PASS Arena availability, default budget/resolution, cache warning and forced refresh preserve mobile form');
  await btn('ให้สมองวางบทและแบ่งช็อต').click();
  await btn('ตรวจแผนและอนุมัติ').waitFor();
  assert.ok(await label('ราคา ElevenLabs USD ต่อ 1000 ตัวอักษร').evaluate(el=>el.readOnly));
  assert.equal(await label('ราคา ElevenLabs USD ต่อ 1000 ตัวอักษร').inputValue(),'0.08');
  assert.equal(await page.getByRole('link',{name:'ดูราคาต้นทาง ElevenLabs'}).getAttribute('href'),'https://elevenlabs.io/pricing/api');
  const creation=await page.evaluate(()=>calls.find(x=>x.path.endsWith('/plans')&&x.method==='POST'));
  assert.equal(creation.body.engine_version,2);assert.equal(creation.body.manual_endpoint,'fal-ai/test');assert.ok(creation.key);
  assert.equal(await page.evaluate(()=>calls.filter(x=>x.path.endsWith('/produce')).length),0);
  await label('พรอมป์ที่จะส่งฉาก 1').fill('A single green leaf unfolding in soft sunlight');
  assert.equal(await btn('ตรวจแผนและอนุมัติ').count(),0);
  await page.getByText('กำกับภาพและการส่งต่อฉาก',{exact:true}).click();
  await page.locator('summary',{hasText:'แก้รายละเอียดกำกับฉาก 1'}).click();
  await label('แก้รายละเอียดกำกับฉาก 1').fill('{');
  await page.getByText(/มี JSON ไม่สมบูรณ์/).waitFor();
  assert.equal(await btn('ตรวจแผนและอนุมัติ').count(),0);
  await label('แก้รายละเอียดกำกับฉาก 1').fill('{"camera":"tracking left","actions":[]}');
  await label('ความยาวที่สร้างฉาก 1').selectOption('10');
  await btn('ตรวจแผนและอนุมัติ').click();
  const dialog=page.locator('dialog[open]');
  await dialog.waitFor();assert.match(await dialog.textContent(),/green leaf unfolding/);
  assert.match(await dialog.textContent(),/fal-ai\/test/);assert.match(await dialog.textContent(),/10 วินาที/);
  await dialog.getByRole('button',{name:'เปลี่ยนโมเดล'}).click();
  await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(await label('โมเดลฉาก 1').evaluate(el=>el===document.activeElement),true);
  await btn('ตรวจแผนและอนุมัติ').click();
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(await page.locator('.drawer').count(),1);
  await btn('ตรวจแผนและอนุมัติ').click();
  await dialog.getByRole('button',{name:'อนุมัติและส่งผลิต'}).evaluate(el=>{el.click();el.click();});
  await page.waitForFunction(()=>calls.some(x=>x.path.includes('/history?job_id=')));
  const approve=await page.evaluate(()=>calls.filter(x=>x.path.endsWith('/produce')));
  assert.equal(approve.length,1);assert.deepEqual(approve[0].body,{approved:true,quote_id:'quote-2',revision:2,confirmation:'CONFIRM quote-2'});
  assert.equal(await page.evaluate(()=>calls.filter(x=>x.method==='PATCH').length),1);
  assert.equal(await page.evaluate(()=>row.plan.shots[0].direction.camera),'tracking left');
  console.log('PASS Edits reprice, review matches saved payload, Cancel/Change Model are free, double-click sends one approval');
  await page.evaluate(()=>{
    window.historyFixture={job:{status:'NEW',stage:'ตรวจคุณภาพ'},events:[{message:'provider completed'}],scenes:[{id:'sample',scene_id:'leaf',model_name:'Available',endpoint_id:'fal-ai/test',status:'completed',estimated_usd:.4,actual_usd:null,
      quality:{method:'sampled_frames',scores:{scene_logic:88},issues:['Missing prop'],recommendations:['Show the leaf'],revised_prompt:'Keep leaf visible'}}]};
  });
  await btn('อัปเดตสถานะ').click();await page.getByText('leaf · Available · completed').click();
  assert.match(await page.locator('.tv-history[open]').textContent(),/ยังไม่ได้ตรวจการเคลื่อนไหว/);
  await label('ให้คะแนนฉาก leaf').selectOption('4');
  await page.waitForFunction(()=>calls.some(x=>x.path.endsWith('/rating')&&x.body.rating===4));
  console.log('PASS Scene history surfaces inspection scope, recommendations and persists owner rating');
  await page.evaluate(()=>{
    const before=api;api=async(path,opts={})=>{
      if(path.endsWith('/revision')){
        calls.push({path,key:opts.headers['idempotency-key']});
        row.status='ready';row.job_id=null;row.job_status=null;
        return {id:row.id,scene_id:'leaf',quality:{recommendations:['Maintain leaf identity'],revised_prompt:'Keep the leaf visible at frame one'}};
      }
      return before(path,opts);
    };
  });
  await btn('สร้างแผนแก้ฉาก').click();await btn('ใช้พรอมป์ที่แนะนำ').click();
  await btn('ตรวจแผนและอนุมัติ').waitFor();
  assert.equal(await label('รูปแบบพรอมป์ฉาก 1').inputValue(),'manual');
  assert.equal(await page.evaluate(()=>row.plan.shots[0].production.prompt),'Keep the leaf visible at frame one');
  assert.equal(await page.evaluate(()=>calls.filter(x=>x.path.endsWith('/produce')).length),1);
  assert.ok(await page.evaluate(()=>calls.find(x=>x.path.endsWith('/revision')).key));
  console.log('PASS QA revision applies a suggested prompt to an editable draft, reprices without paid retries');
  await page.evaluate(()=>{
    document.querySelector('.drawer .d-top button').click();
    delete row.request.engine_version;row.status='ready';row.job_status=null;row.job_id=null;row.request.video_model='legacy';row.request.resolution='720p';row.quote=null;openTextVideo(row.id);
  });
  await btn('ตรวจราคาก่อนผลิต').waitFor();
  assert.equal(await label('โมเดลวิดีโอ fal.ai').inputValue(),'legacy');
  assert.equal(await label('ราคา ElevenLabs USD ต่อ 1000 ตัวอักษร').evaluate(el=>el.readOnly),false);
  console.log('PASS Historical v1 plan retains its legacy editor and approval controls');
  await page.evaluate(()=>{
    document.querySelector('.drawer .d-top button').click();
    TV_CONFIG.voice_usd_per_1000_characters=null;
    row.request.engine_version=2;row.plan.shots[0].production.audio=true;
    window.nativeQuoteStart=calls.filter(c=>c.path.endsWith('/quote')).length;openTextVideo(row.id);
  });
  await btn('ตรวจแผนและอนุมัติ').waitFor();
  assert.equal(await label('ราคา ElevenLabs USD ต่อ 1000 ตัวอักษร').inputValue(),'');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.path.endsWith('/quote')).length-nativeQuoteStart),1);
  assert.equal(await page.evaluate(()=>Object.hasOwn(calls.filter(c=>c.path.endsWith('/quote')).at(-1).body,'eleven_usd_per_1000_characters')),false);
  console.log('PASS Native-only plan obtains a quote with no verified ElevenLabs rate and no client-supplied price');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
