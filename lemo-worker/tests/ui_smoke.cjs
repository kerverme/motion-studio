const {chromium}=require('playwright-core');const fs=require('fs'),http=require('http'),assert=require('assert/strict');
const root=require('path').resolve(__dirname,'../..');const fixture=JSON.parse(fs.readFileSync(root+'/lemo-worker/tests/fixtures/dream.json'));const plan=fixture.creative;
const styles=JSON.parse(fs.readFileSync(root+'/api/src/lemo-styles.json'));
const previews=JSON.parse(fs.readFileSync(root+'/api/src/lemo-style-previews.json'));
const weights={relevance:.3,storytelling:.25,emotion:.15,characters:.1,continuity:.1,feasibility:.1};
const ranked=plan.candidates.map(c=>({...c,score:Object.entries(weights).reduce((a,[k,v])=>a+c.scores[k]*v,0)})).sort((a,b)=>b.score-a.score);
const settings={version:1,engine:'lemo',mode:'auto',locked:false,tts_model:'eleven_v4',sfx_model:'eleven_text_to_sound_v3',max_usd:10,weights};
const d={id:'10000000-0000-0000-0000-000000000888',status:'ready',topic:fixture.topic,story_mode:'general',draft:{title_th:fixture.topic,script:fixture.script},storyboard:{script:fixture.script,creative:plan},creative:{engine:'lemo',settings,selection:{selected:ranked[0],alternatives:ranked.slice(1),plan,low_confidence:false}},model:'gpt-6.1-sol',usage:{input_tokens:0,output_tokens:0},source_text:'Mock source fixture'};
const calls=[], errors=[];
const output=process.env.LEMO_UI_OUTPUT||'/tmp/lemo-ui';
const jobId='10000000-0000-0000-0000-000000000889';
let revision=1, jobStatus='FAILED';
const quote=()=>({
  revision:'mock-revision-'+revision,quote_hash:'mock-quote-'+revision,
  items:['planning','style','coding','narration','sfx','music','compute','other'].map((category,i)=>({
    category,quantity:[0,0,8,100,2,0,1,0][i],estimated_usd:[0,0,null,null,null,0,null,0][i]})),
  unknown:['coding','narration','sfx','compute'],known_total_usd:0,planning_usage:{input_tokens:0,output_tokens:0},
  lemo_approval:{available:true,max_usd:d.creative.settings.max_usd,
    allocations:Object.fromEntries(['coding','narration','sfx','compute'].map(category=>[category,d.creative.settings.max_usd/4])),
    unknown_ack_required:true,style_ack_required:false},
  gates:{enabled:true,blockers:[]}
});
fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{const path=req.url.split('?')[0];res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':'text/html; charset=utf-8');if(path==='/app/text-video.js')res.end(fs.readFileSync(root+'/api/src/text-video-ui.js'));else res.end(fs.readFileSync(root+'/api/src/ui.html'));});
(async()=>{await new Promise(r=>server.listen(8766,'127.0.0.1',r));const browser=await chromium.launch({executablePath:process.env.LEMO_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});try{const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});page.on('pageerror',e=>errors.push(e.message));
await page.route('**/app/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let data={};
if(['POST','PATCH'].includes(req.method()))calls.push({method:req.method(),path,body:req.postData()?req.postDataJSON():null});
if(path.endsWith('/me'))data={ui_enabled:true,authed:true};
else if(path.endsWith('/studio/status'))data={llm:true,web_search:true,models:[{id:'gpt-6.1-sol',label:'GPT-6.1 Sol'}],model:'gpt-6.1-sol',reasoning_levels:['medium'],reasoning:'medium',formats:{},daily_limit:100,drafts_today:0,max_credits:6000,creative:{enabled:true,development:false,styles}};
else if(path==='/app/api/studio/drafts'&&req.method()==='POST')data={id:d.id};
else if(path==='/app/api/studio/drafts')data={drafts:[]};
else if(path.startsWith('/app/api/studio/drafts/'))data=d;
else if(path.endsWith('/studio/characters'))data={characters:[]};
else if(path.endsWith('/episodes'))data={episodes:[],counts:{ready:0,used:0,working:0}};
else if(path.endsWith('/studio/styles'))data={styles:[]};
else if(path.endsWith('/studio/music-default'))data={available:false,candidates:[]};
else if(path.endsWith('/estimate'))data=quote();
else if(path==='/app/api/creative/'+d.id&&req.method()==='PATCH'){
  const edit=req.postDataJSON();
  d.creative.settings=edit.settings;d.creative.selection.plan=edit.plan;d.storyboard.script=edit.script;
  revision++;data={ok:true};
}
else if(path==='/app/api/creative/'+d.id+'/approve'){
  d.status='submitted';d.job_id=jobId;d.job_status=jobStatus;data={id:jobId};
}
else if(path==='/app/api/creative/jobs/'+jobId){
  data={id:jobId,status:jobStatus,stage:'RENDERING',progress:.25,assets:[],calls:[],error:jobStatus==='FAILED'?'Fixture interrupted before rendering':null};
}
else if(path==='/app/api/creative/jobs/'+jobId+'/retry'){jobStatus=d.job_status='NEW';data={ok:true,id:jobId};}
else if(path==='/app/api/creative/capabilities')data={styles:styles.map(style=>({...style,preview:previews[style.id]}))};
else if(path.startsWith('/app/api/creative/'))data={ok:true};
await route.fulfill({json:data});});
await page.goto('http://127.0.0.1:8766/app/');await page.getByLabel('Rendering engine').waitFor();assert.equal(await page.getByLabel('โมเดลเสียง',{exact:true}).inputValue(),'eleven_v4');
await page.getByLabel('Rendering engine').selectOption('lemo');
const mode=page.getByLabel('การเลือกสไตล์');
assert.equal(await mode.inputValue(),'auto');
await mode.selectOption('manual');
const picker=page.getByLabel('สไตล์ Lemo',{exact:true});
assert.equal(await picker.locator('option').count(),99);
assert.equal(await picker.locator('optgroup').count(),15);
await picker.selectOption('glass-product');await page.getByLabel('หัวข้อเรื่อง',{exact:true}).fill(fixture.topic);
await page.screenshot({path:(process.env.LEMO_UI_OUTPUT||'/tmp/lemo-ui')+'/create-engine.png',fullPage:true});
await page.getByRole('button',{name:'เริ่มค้นและเขียน',exact:true}).click();
const production=page.getByLabel('ยืนยันการผลิต Lemo',{exact:true});
const confirm=production.getByRole('button',{name:'ยืนยันผลิตคลิป',exact:true});
await confirm.waitFor();
assert.ok(await confirm.isEnabled());
assert.equal(await production.locator('input:visible,select:visible,textarea:visible').count(),0);
const narration=page.getByLabel('บทฉาก s1',{exact:true});
assert.equal(await narration.isVisible(),false);
assert.match(await production.innerText(),/10(?:\.0+)?\s*USD/);
assert.equal(calls.length,1);
assert.deepEqual(calls[0].body.characters,[]);
assert.equal(calls[0].body.creative.engine,'lemo');
assert.equal(calls[0].body.creative.manual_style,'glass-product');
await page.screenshot({path:output+'/ready-to-produce.png'});

await page.locator('summary').filter({hasText:'ปรับบท สไตล์ และรายละเอียดฉาก'}).click();
assert.equal(await narration.inputValue(),fixture.script[0].text);
const reviewPicker=page.getByLabel('สไตล์หลัก',{exact:true}),reviewMode=page.getByLabel('การเลือกสไตล์ตอนตรวจบท');
assert.equal(await reviewPicker.locator('option').count(),99);
assert.equal(await reviewPicker.locator('optgroup').count(),15);
await reviewPicker.selectOption('glass-product');assert.equal(await reviewMode.inputValue(),'manual');
await reviewMode.selectOption('auto');assert.equal(await reviewPicker.inputValue(),ranked[0].id);
const edited='ลองสังเกตสิ่งที่เกิดขึ้นตอนหลับ';
await narration.fill(edited);assert.ok(await confirm.isDisabled());
const budget=page.getByRole('spinbutton',{name:'วงเงินผลิตสูงสุด (USD)',exact:true});
const save=page.getByRole('button',{name:'บันทึกการแก้ไข',exact:true});
assert.equal(await budget.inputValue(),'10');
for(const amount of ['0','1001']){
  await budget.fill(amount);await save.click();
  assert.ok(await page.getByRole('alert').filter({hasText:'กรอกวงเงินผลิตมากกว่า 0'}).isVisible());
  assert.equal(calls.filter(call=>call.method==='PATCH').length,0);
  assert.ok(await confirm.isDisabled());
}
await budget.fill('8');
await page.screenshot({path:output+'/storyboard.png'});
await Promise.all([
  page.waitForResponse(r=>r.url().endsWith('/estimate')&&r.status()===200),
  save.click(),
]);
assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
assert.equal(calls.find(c=>c.method==='PATCH').body.settings.max_usd,8);
assert.equal(d.storyboard.script[0].text,edited);
assert.match(await production.innerText(),/วงเงินผลิตสูงสุด 8\.00 USD/);
assert.ok(await confirm.isEnabled());
await page.locator('summary').filter({hasText:'รายละเอียดค่าใช้จ่าย'}).click();
assert.ok(await production.getByRole('table').isVisible());
await page.screenshot({path:output+'/cost-review.png'});

const approvePath='/app/api/creative/'+d.id+'/approve';
await confirm.evaluate(button=>{button.click();button.click();});
const retry=page.getByRole('button',{name:'ซ่อมต่อจากจุดที่บันทึกไว้',exact:true});
await retry.waitFor();
assert.deepEqual(calls.filter(c=>c.path===approvePath),[{
  method:'POST',path:approvePath,body:{confirm:true,revision:'mock-revision-2',quote_hash:'mock-quote-2'}
}]);
await Promise.all([
  page.waitForResponse(r=>r.url().endsWith('/jobs/'+jobId+'/retry')&&r.status()===200),
  retry.click(),
]);
assert.equal(calls.filter(c=>c.path===approvePath).length,1);
assert.equal(calls.filter(c=>c.path.endsWith('/retry')).length,1);
assert.equal(errors.length,0,errors.join('\n'));
console.log(JSON.stringify({passed:true,requests:calls.length,approvals:1,jobRetries:1,paid_provider_calls:0,screenshots:output}));
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
