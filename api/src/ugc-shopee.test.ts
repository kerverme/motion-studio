import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readListing, ideaCards } from './ugc-shopee.js';

const url='https://shopee.co.th/Travel-Tumbler-i.123.456';
const time='2026-11-27T12:30:00.000Z';
function page(body:string,landing=url,canonical=url){
  return {cache_hit:true,collected_at:time,payload:{data:{markdown:body,metadata:{url:landing,ogUrl:canonical,statusCode:200}}}};
}

test('Shopee observations require the exact Thai product and independent evidence on its detail page',()=>{
  const content='# แก้วเก็บความเย็น\nขายแล้ว 60k+ ชิ้น\nโปรโมชั่นลูกค้าใหม่\n฿1\n฿299\n## การจัดส่ง\nร้านตัวอย่าง\nแชทเลย\n## สินค้าอื่น\nขายดีอันดับ 1\n฿4';
  const row=readListing(url,page(content))!;
  assert.equal(row.name,'แก้วเก็บความเย็น');
  assert.equal(row.price,null);assert.equal(row.shop,'ร้านตัวอย่าง');
  assert.equal(row.signal,'ขายแล้ว 60k+ ชิ้น');assert.equal(row.label,'ยอดขายสะสมที่หน้าแสดง');
  assert.equal(row.checked_at,time);assert.equal(row.cached,true);
  const plain=readListing(url,page('# แก้วพร้อมฝา\n฿399\n## การจัดส่ง\nขายแล้ว 300 ชิ้น'))!;
  assert.deepEqual([plain.price,plain.signal,plain.label],['฿399',null,'สินค้าที่พบ']);
  assert.equal(readListing(url,page('# แก้ว\nสินค้าขายดี'))?.label,'ขายดีตามป้าย Shopee');
  for(const bad of ['https://shopee.co.th/buyer/login','https://shopee.co.th/product/123/457','https://example.org/product/123/456']){
    assert.equal(readListing(url,page(content,bad)),null);assert.equal(readListing(url,page(content,url,bad)),null);
  }
  assert.equal(readListing(url,page('# เข้าสู่ระบบ')),null);
});

test('LLM editorial copy cannot overwrite facts or turn a listing into a growth claim',()=>{
  const item=readListing(url,page('# แก้วน้ำ\n฿99\n## ข้อมูล'))!;
  const malicious={id:item.id,angle:'closeup',reason:'ยอดขายโต 80%',hook:'ลดราคาเหลือสิบบาท',price:1,signal:'ขายดีอันดับหนึ่ง'};
  const [card,...extra]=ideaCards([item],JSON.stringify({picks:[malicious,malicious,{id:'other',angle:'scale'}]}));
  assert.equal(extra.length,0);assert.equal(card.price,'฿99');assert.equal(card.signal,null);
  assert.doesNotMatch(card.reason+card.hook,/ยอดขาย|ลดราคา/);
  const creative={id:item.id,angle:'closeup',reason:'ถ่ายเทียบกับมือให้คนดูเห็นขนาด',hook:'แก้วนี้จับถนัดมือไหม มาดูกัน'};
  const [valid]=ideaCards([item],JSON.stringify({picks:[creative]}));
  assert.equal(valid.hook,creative.hook);assert.equal(valid.reason,creative.reason);
});
