import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeItem} from './adapter.js';
test('observed Instagram metadata is distinct from discovery and rounded counts stay unknown',()=>{
 const e=normalizeItem({url:'https://www.instagram.com/reel/ObservedPost/',published_at:'2026-11-12T08:00:00Z',caption:'ท้องฟ้าเปลี่ยนสี',view_count:26500,view_count_approximate:true,engagement:{likes:1400,comments:null},detail_read:true},'2026-11-14T08:00:00Z');
 assert.equal(e?.publishedAt,'2026-11-12T08:00:00.000Z');assert.equal(e?.observedAt,'2026-11-14T08:00:00Z');assert.equal(e?.likes,1400);assert.equal(e?.views,null);assert.equal(e?.comments,null);
 assert.equal(normalizeItem({url:'https://example.com/post'}),null);
 assert.equal(normalizeItem({url:'https://instagram.com/p/abc/',published_label:'yesterday'})?.publishedAt,null);
});
test('TikTok detail field names preserve observed publication and exact string metrics',()=>{
 const e=normalizeItem({url:'https://www.tiktok.com/@fixture/video/123456789',created_at:'2026-11-12T08:00:00.000Z',description:'Observed caption',views:'10000',likes:'1500',comments_count:'25',detail_read:true});
 assert.equal(e?.publishedAt,'2026-11-12T08:00:00.000Z');assert.equal(e?.views,10000);assert.equal(e?.likes,1500);assert.equal(e?.comments,25);
});
