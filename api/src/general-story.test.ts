import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Draft,checkDraft,buildPackage,systemPrompt} from './studio.js';
import {Storyboard} from './storyboard.js';
import {emptyArtwork,updateArtwork,artworkComplete,mergeArtwork} from './art-batches.js';

function general() {
  const script=[{id:'hook',beat:'hook',text:'ทำไมตื่นแล้ว ยังรู้สึกไม่สดชื่น'},...['water','light','routine'].map(id=>({id,beat:'rehook',text:'ลองดูสิ่งที่เกิดขึ้นในตอนเช้า เราจะอธิบายทีละขั้นด้วยภาพแก้วน้ำและนาฬิกา โดยแยกคำแนะนำของผู้ให้สัมภาษณ์ออกจากหลักฐานที่ตรวจสอบได้ ข้อมูลบางส่วนอาจแตกต่างกันในแต่ละคน'})),{id:'end',beat:'cta',text:'คุณอยากเริ่มจากข้อไหน ลองเล่าในคอมเมนต์ให้ฟังหน่อย'}];
  const storyboard=Storyboard.parse({story_mode:'general',script,shots:script.map(s=>({seg:s.id,visual:'A glass of water next to a clock and a bright window',action:'Sunlight moves across the clock',camera:'Close-up with a slow pan',characters:[]})),character_notes:'No people: use water, sunlight, clock and diagrams.'});
  return Draft.parse({story_mode:'general',storyboard,script,title_th:'เช้าที่สดชื่น เริ่มจากอะไร',format:'mystery',cast:[],scenes:script.map(s=>({seg:s.id,type:'custom',code:'def draw(c,t,p):\n  c.grad("sky","cream")\n  c.rect(400,600,240,360,"teal")'})),art:'',sources:[{url:'https://example.org/sleep',publisher:'Example',published:String(new Date().getUTCFullYear()),claim:'ข้อมูลการนอน'}],claims:[{text:'ตัวอย่างรูทีนที่เสนอให้ทดลอง',kind:'assumption',source_ids:[]}],captions:{facebook:'เช้าที่สดชื่น',instagram:'เช้าที่สดชื่น',tiktok:'เช้าที่สดชื่น',youtube:'เช้าที่สดชื่น',twitter:'เช้าที่สดชื่น'}});
}
test('general story accepts topical opener and fully character-free drawings',()=>{
  const d=general(); assert.deepEqual(checkDraft(d,null).problems,[]);
  let artwork=emptyArtwork();for(const scene of d.scenes)artwork=updateArtwork(artwork,'draw_scene',{scene},d.storyboard!);
  assert.equal(artworkComplete(artwork,d.storyboard!),true);
  const assembled=mergeArtwork({script:d.script},artwork);assert.deepEqual(assembled.cast,[]);
  const pkg=buildPackage('เล่าเรื่องเช้า',d,[]);assert.equal('cover' in pkg,false);
  assert.ok(pkg.scene_code.includes('strict_art'));assert.ok(!pkg.scene_code.includes('คนนี้ชื่อ'));
});
test('fact source references are zero-based and invalid indices return actionable metadata repair',()=>{
  const d=general();
  d.claims=[{text:'ข้อมูลการนอนจากต้นฉบับ',kind:'fact',source_ids:[0]}];
  assert.deepEqual(checkDraft(d,null).problems,[]);
  assert.ok(checkDraft(d,new Map()).problems.some(p=>p.includes('was not retrieved')),'valid indices must not bypass source evidence validation');
  d.claims[0].source_ids=[1];
  const problems=checkDraft(d,null).problems;
  assert.equal(problems.length,1);
  assert.match(problems[0],/source_ids=\[1\]/);
  assert.match(problems[0],/zero-based indices into sources\[\]/);
  assert.match(problems[0],/valid range: 0\.\.0/);
  assert.match(problems[0],/With one source, use \[0\]/);
  assert.match(problems[0],/does not mean an already retrieved URL needs fetching again/);
  assert.deepEqual(d.claims[0].source_ids,[1],'validation must not silently change the cited source');
  d.sources=[];
  assert.ok(checkDraft(d,null).problems.some(p=>p.includes('valid range: none (sources is empty)')));
});
test('name-series validation stays enforced and modes cannot silently mismatch',()=>{
  const d=general();assert.equal(Storyboard.safeParse({...d.storyboard,story_mode:undefined}).success,false);
  assert.ok(checkDraft({...d,story_mode:'name_story'},null).problems.some(x=>x.includes('cast[0]')));
  assert.ok(checkDraft({...d,story_mode:undefined},null).problems.some(x=>x.includes('story mode')));
});
test('general prompt does not instruct an automatic name or compulsory human',()=>{
  const p=systemPrompt({fc:false,ws:true},'general');
  assert.ok(p.includes('shots.characters: []'));assert.ok(p.includes('Owner supplied source text is unverified'));
  assert.ok(!p.includes('Every clip has a main character'));assert.ok(!p.includes('pick a common Thai name'));
  assert.ok(systemPrompt({fc:false,ws:true}).includes('Every clip has a main character'));
});
