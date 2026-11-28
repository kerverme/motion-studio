import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arenaModels, featuredUrl, matchRank, noteworthyModels } from './ugc-ranked.js';
import type { UgcFalIdentity } from './video-registry.js';

function flight(data:unknown){
  const line='b:'+JSON.stringify(['$','component',null,{props:data}])+'\n';
  const middle=Math.floor(line.length/2);
  return new Response([line.slice(0,middle),line.slice(middle)].map(chunk=>
    '<script>self.__next_f.push('+JSON.stringify([1,chunk])+')</script>').join(''));
}
const arena=(rank:number,name:string)=>({rank,modelKey:name,modelDisplayName:name,modelOrganization:'MiniMax'});
test('reads every overall Models page in published order including tied ranks',async()=>{
  const seen:string[]=[];
  const rows=await arenaModels(async url=>{
    const cursor=new URL(String(url)).searchParams.get('cursor');
    seen.push(cursor||'first');
    return flight([{arenaSlug:'text-to-video',leaderboardSlug:'overall',entries:[arena(1,'other')]},
      {arenaSlug:'image-to-video',leaderboardSlug:'overall',totalModels:3,...(!cursor?{nextCursor:'p2'}:{}),
        entries:cursor?[arena(2,'H3 Max')]:[arena(1,'one'),arena(2,'H3')]}]);
  });
  assert.deepEqual(seen,['first','p2']);assert.deepEqual(rows.map(r=>[r.rank,r.name]),[[1,'one'],[2,'H3'],[2,'H3 Max']]);
  await assert.rejects(arenaModels(async()=>flight({arenaSlug:'image-to-video',leaderboardSlug:'overall',totalModels:2,entries:[arena(1,'one')]})),/ซ้ำ/);
});
test('reads only fal editorial section, filters modality after complete pagination',async()=>{
  const calls:string[]=[];
  const read=async(url:RequestInfo|URL)=>{
    calls.push(String(url));
    const second=new URL(String(url)).searchParams.get('page')==='2';
    const models=second?[{model:{endpoint:'brand/vid',category:'image-to-video'}}]:[{model:{endpoint:'brand/img',category:'text-to-image'}}];
    return flight([{slug:'popular',models},{slug:'new-and-noteworthy',total:2,models}]);
  };
  assert.deepEqual(await noteworthyModels(read),['brand/vid']);
  assert.deepEqual(calls,[featuredUrl,featuredUrl+'?page=2']);
  await assert.rejects(noteworthyModels(async()=>new Response('blocked',{status:403})),/HTTP 403/);
});
test('strict developer, version, date, resolution and input mode identities',()=>{
  const row=(name:string,developer='MiniMax')=>({name,developer,key:name,rank:1});
  const entry=(id:string,name:string,category='image-to-video'):UgcFalIdentity=>({id,name,category,active:true});
  const max=entry('minimax/h3-max/image-to-video','MiniMax H3 Max');
  assert.equal(matchRank(row('MiniMax H3'),[max]).id,undefined);
  assert.match(matchRank(row('MiniMax H3'),[max]).reason!,/รุ่นหรือ variant/);
  assert.equal(matchRank(row('MiniMax H3 Max'),[max]).id,max.id);
  assert.equal(matchRank(row('MiniMax H3 Max','Different Org'),[max]).id,undefined);
  assert.match(matchRank(row('MiniMax H3'),[entry('minimax/h3/text-to-video','MiniMax H3','text-to-video')]).reason!,/ไม่รับภาพเปิด/);
  assert.match(matchRank(row('MiniMax H3'),[entry('minimax/h3/reference-to-video','MiniMax H3')]).reason!,/ไม่รับภาพเปิด/);
  const grok=entry('xai/grok-imagine-video/image-to-video','Grok Imagine Video');
  assert.equal(matchRank(row('Grok Imagine Video (480p)','SpaceXAI'),[grok]).resolution,'480p');
  assert.equal(matchRank(row('FLUX 3 Video (20260811)','Black Forest Labs'),[entry('blackforestlabs/flux-3/image-to-video','FLUX 3 Video')]).id,undefined);
});

test('UGC uses the schema field for the opening frame, including a route with a nonstandard name',async()=>{
  const {ugcOpeningField}=await import('./ugc-contract.js');
  const model=(endpoint_id:string,properties:Record<string,unknown>)=>({category:'image-to-video' as const,endpoint_id,input_schema:{properties}});
  assert.equal(ugcOpeningField(model('studio/animate',{start_image_url:{type:'string'}})),'start_image_url');
  assert.equal(ugcOpeningField(model('studio/image-to-video',{image_url:{description:'subject reference portrait only'}})),null);
  assert.equal(ugcOpeningField(model('studio/reference-to-video',{image_url:{}})),null);
  assert.equal(ugcOpeningField(model('studio/image-to-video',{first_frame_url:{}})),'first_frame_url');
});
