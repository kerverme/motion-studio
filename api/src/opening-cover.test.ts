import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Draft,buildPackage,systemPrompt} from './studio.js';
import {buildInput,buildMutation,thumbnailOffsetFor} from './buffer.js';

test('new opening covers stay bound to frame zero while legacy deliveries keep 1500ms',()=>{
  const script=['first','later','third','last'].map(id=>({id,text:'คำถาม',beat:'hook'}));
  const d=Draft.parse({cover_mode:'opening_frame',title_th:'หัวข้อ',script,cast:[{name:'ทดสอบ'}],scenes:script.map(s=>({seg:s.id,type:'custom',code:'def draw(c,t,p):\n    c.rect(100,100,200,200,"teal")'})),sources:[{url:'https://example.org/source',publisher:'Example',published:'2026',claim:'ข้อมูล'}],claims:[{text:'ข้อมูล',kind:'assumption',source_ids:[]}],captions:{facebook:'หัวข้อ',instagram:'หัวข้อ',tiktok:'หัวข้อ',youtube:'หัวข้อ',twitter:'หัวข้อ'},thumbnail:{seg:'later',title:'คำถาม'}});
  const pkg=buildPackage('หัวข้อ',d,[]);
  assert.deepEqual(pkg.thumbnail,{mode:'opening_frame',seg:'first',offset:0,title:'คำถาม'});
  assert.equal('cover' in pkg,false);
  assert.match(pkg.scene_code,/opening_frame_cover.*true/);
  const old=buildPackage('หัวข้อ',{...d,cover_mode:undefined},[]);
  assert.equal(old.thumbnail.offset,1.5);assert.equal('cover' in old,true);
  for(const mode of [undefined,null,'unknown'])assert.equal(thumbnailOffsetFor(mode),1500);
  assert.equal(thumbnailOffsetFor(pkg.thumbnail.mode),0);
});
test('Buffer serializes zero rather than dropping it as falsy',()=>{
  for(const service of ['instagram','tiktok']) {
    const p={channel:{id:'channel',name:'test',service},text:'caption',videoUrl:'https://example.org/video.mp4',mode:'addToQueue' as const,thumbnailOffsetMs:thumbnailOffsetFor('opening_frame')};
    assert.match(buildMutation(p),/thumbnailOffset: 0/);
    assert.doesNotMatch(buildMutation(p),/thumbnailUrl/);
    assert.equal((buildInput(p).assets as any)[0].video.metadata.thumbnailOffset,0);
    for(const service of ['facebook','twitter'])assert.equal((buildInput({...p,channel:{...p.channel,service}}).assets as any)[0].video.metadata,undefined);
  }
});
test('both story modes require a complete moving opening with no held intro',()=>{
  for(const mode of ['general','name_story'] as const){
    const prompt=systemPrompt({fc:false,ws:true},mode);
    assert.ok(prompt.includes('first video frame at t=0'));
    assert.ok(prompt.includes('no frozen intro'));
    assert.ok(prompt.includes('Start subtle motion immediately'));
  }
});
