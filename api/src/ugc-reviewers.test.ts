import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { notionProducts } from './ugc-notion.js';

const db='67c8a896-977d-4bb9-ab20-ae93e078576a', page='87ac8d3b-4250-4a8e-9d9a-744bbf8dfc7e';
test('reviewer photos use the configured Notion database, distinct file identities and a fresh download on import',async()=>{
  let version=1,parent=db,pages=0;
  const files=()=>['a','b'].map(key=>({type:'file',name:'photo.png',file:{url:'https://file.notion.so/'+key+'/photo.png?sig='+version}}));
  const person=()=>({id:page,parent:{database_id:parent},properties:{Name:{id:'title',title:[{plain_text:'มิน'}]},Photo:{id:'files',files:files()}}});
  const received:string[]=[];
  const fetcher:typeof fetch=async(input,opts)=>{
    const u=new URL(String(input));
    if(u.hostname==='file.notion.so'){
      assert.equal(new Headers(opts?.headers).get('authorization'),null);
      received.push(u.pathname+u.search);
      return new Response(new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]));
    }
    assert.equal(u.hostname,'api.notion.com');
    if(u.pathname.endsWith('/query')){
      assert.equal(JSON.parse(String(opts?.body)).filter.title.contains,'มิน');
      return Response.json({results:[person()],has_more:false});
    }
    if(u.pathname.startsWith('/v1/pages/')){pages++;return Response.json(person());}
    return Response.json({properties:{Name:{id:'title',type:'title'},Photo:{id:'files',name:'Portraits',type:'files'},Other:{id:'other',type:'files'}}});
  };
  const pool={} as pg.Pool;
  const env={UGC_NOTION_TOKEN:'fixture',UGC_NOTION_REVIEWER_DATABASE_ID:db,UGC_NOTION_REVIEWER_IMAGE_PROPERTY:'Portraits'};
  const service=notionProducts(pool,null,fetcher,env);
  assert.ok(service.reviewers.enabled);assert.equal(service.enabled,false);
  const {items}=await service.reviewers.list('มิน');
  assert.equal(items.length,2);assert.notEqual(items[0].file,items[1].file);
  assert.ok(items.every(x=>x.thumbnail.startsWith('/app/')&&!x.thumbnail.includes('sig=')));
  await service.reviewers.image(page,items[1].file,true);assert.equal(pages,0);
  version++;
  assert.equal((await service.reviewers.image(page,items[1].file)).type,'image/png');
  assert.deepEqual(received,['/b/photo.png?sig=1','/b/photo.png?sig=2']);
  parent=page;
  await assert.rejects(service.reviewers.image(page,items[1].file),/นอกฐาน/);
  const unmapped=notionProducts(pool,null,fetcher,{...env,UGC_NOTION_REVIEWER_IMAGE_PROPERTY:''});
  await assert.rejects(unmapped.reviewers.list(''),/คอลัมน์/);
  const off=notionProducts(pool,null,fetcher,{});
  assert.equal(off.reviewers.enabled,false);await assert.rejects(off.reviewers.list(''),/ยังไม่ได้ตั้งค่า/);
});
