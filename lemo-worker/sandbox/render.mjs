// Trusted harness. The film executes only in Chromium inside the gVisor container.
import fs from 'node:fs';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {chromium} from 'playwright-core';
const input=[];let bytes=0;
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>800000)throw Error('Source too large');input.push(chunk);}
const spec=JSON.parse(Buffer.concat(input).toString());
if(typeof spec.html!=='string'||spec.html.length>600000)throw Error('Invalid HTML');
const w=spec.width??1080,h=spec.height??1920,fps=spec.fps??30,duration=spec.duration;
if(![360,540,1080].includes(w)||h!==w*16/9||fps!==30||!Number.isFinite(duration)||duration<=0||duration>40)throw Error('Unsupported render specification');
fs.mkdirSync('/tmp/out',{recursive:true});
const server=http.createServer((req,res)=>{
  const files={'/film':'text/html','/core/lib.js':'application/javascript'};
  if(!files[req.url]){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',files[req.url]);
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
  res.end(req.url==='/film'?spec.html:fs.readFileSync('/renderer/lib.js'));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
// --no-sandbox is restricted to this credential-free, networkless gVisor container.
// The host coordinator must refuse any runtime other than runsc.
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking'],env:{HOME:'/tmp',PATH:'/usr/bin:/bin'}});
const page=await browser.newPage({viewport:{width:w,height:h},deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false});
let pageError=null;page.on('pageerror',e=>{pageError=e.message;});
await page.route('**/*',r=>[origin+'/film',origin+'/core/lib.js'].includes(r.request().url())?r.continue():r.abort());
page.on('popup',p=>p.close());
await page.goto(origin+'/film',{timeout:15000});
await page.waitForFunction(()=>window.READY===true&&typeof window.render==='function',null,{timeout:15000});
const start=performance.now(),frames=Math.ceil(duration*fps);
const enc=spawn('ffmpeg',['-v','error','-y','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-threads','2','-frames:v',String(frames),'/tmp/out/video.mp4'],{stdio:['pipe','ignore','pipe']});
let encError='';enc.stderr.on('data',c=>encError+=String(c).slice(0,2000));
const encDone=new Promise((resolve,reject)=>{enc.on('error',reject);enc.on('close',code=>code===0?resolve():reject(Error(encError)));});
enc.stdin.on('error',()=>{});
const previews=[0,Math.floor(frames*.4),Math.max(0,frames-1)];
for(let frame=0;frame<frames;frame++){
  await page.evaluate(t=>window.render(t),frame/fps);
  if(pageError)throw Error(pageError.slice(0,1000));
  if(previews.includes(frame))await page.screenshot({path:`/tmp/out/preview-${previews.indexOf(frame)}.png`});
  const data=await page.screenshot({type:'jpeg',quality:94});
  if(!enc.stdin.write(data))await new Promise(resolve=>enc.stdin.once('drain',resolve));
}
enc.stdin.end();await encDone;
const timing={render_seconds:(performance.now()-start)/1000,frames,width:w,height:h,fps,requested_duration:duration,upstream:'3a7132b996be0241c1ea0ab180d519f06e6f10b6',renderer:'canvas2d',node_rusage:process.resourceUsage()};
fs.writeFileSync('/tmp/out/metadata.json',JSON.stringify(timing));
await browser.close();await new Promise(resolve=>server.close(resolve));
const tar=spawn('tar',['-C','/tmp/out','-cf','-','video.mp4','preview-0.png','preview-1.png','preview-2.png','metadata.json'],{stdio:['ignore','pipe','inherit']});
tar.stdout.pipe(process.stdout);await new Promise((resolve,reject)=>tar.on('exit',c=>c===0?resolve():reject(Error('Archive failed'))));
