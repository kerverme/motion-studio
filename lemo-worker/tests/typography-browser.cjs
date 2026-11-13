// Trusted typography fixture only; never load a generated film in this local browser.
const {firefox}=require('playwright'),fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
  const browser=await firefox.launch({headless:true,env:{...process.env,MOZ_DISABLE_CONTENT_SANDBOX:'1'}});
  try{
    const page=await browser.newPage({viewport:{width:1080,height:1920}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const html=fs.readFileSync(process.argv[2],'utf8');
    assert(html.includes('data-trusted-typography-fixture'),'Only the hand-authored test fixture may run locally');
    await page.route('**/*',r=>r.request().url()==='http://typography.test/fixture'?r.fulfill({status:200,headers:{'content-type':'text/html','content-security-policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"},body:html}):r.abort());
    await page.goto('http://typography.test/fixture');
    await page.waitForFunction(()=>window.READY===true);
    const result=await page.evaluate(()=>{
      window.render(0);
      const c=document.querySelector('canvas').getContext('2d');
      c.font='900 35px "Noto Sans Thai"';
      const labelWidth=c.measureText('เรื่องสมมติ').width;
      return {font:c.font,labelWidth,loaded:document.fonts.check('800 108px "Motion Kanit"'),ready:window.READY};
    });
    assert(result.loaded);assert.match(result.font,/48px.*Motion Kanit/);
    assert(result.labelWidth>210&&result.labelWidth<239,'Thai label must fit its sign without stretching');
    assert.deepEqual(errors,[]);
    fs.mkdirSync(process.argv[3],{recursive:true});
    await page.screenshot({path:process.argv[3]+'/trusted-font-fixture.png'});
    fs.writeFileSync(process.argv[3]+'/trusted-font-fixture.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify({...result,pageErrors:errors}));
  }finally{await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
