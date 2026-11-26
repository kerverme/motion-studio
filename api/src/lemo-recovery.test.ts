import {test} from 'node:test';
import assert from 'node:assert/strict';
import {savedLemoDraft} from './lemo-recovery.js';

test('a reviewed citation keeps the archived claim and source index and must match saved retrieval evidence',()=>{
  const original_url='https://publisher.example/guide',url='https://publisher.example/announcement';
  const at='2026-11-26T09:00:00.000Z', row={storyboard:{script:[{id:'s1'}]},research:[{kind:'web',at,results:[{url:original_url},{url}]}]};
  const input={sources:[{url:original_url,publisher:'Publisher',claim:'Six regions are described',published:'',confidence:'high'}],claims:[{kind:'fact',source_ids:[0]}]};
  const citation={index:0,original_url,url,title:'Publication',publisher:'Publisher',published:'2026-11-18',methodology:'Read the dated announcement',limitations:'A summary'};
  const d=savedLemoDraft(row,input,citation);
  assert.equal(d.sources[0].url,url);assert.equal(d.sources[0].published,citation.published);
  assert.deepEqual(d.claims,input.claims);assert.equal(d.sources[0].claim,input.sources[0].claim);
  assert.equal(input.sources[0].published,'');assert.equal(d.research_seen[1].collected,at);
  assert.throws(()=>savedLemoDraft(row,input,{...citation,url:'https://unvisited.example'}),/retrieval evidence/);
  assert.throws(()=>savedLemoDraft(row,input,{...citation,index:1}),/reviewed index/);
  assert.throws(()=>savedLemoDraft(row,input,{...citation,published:'unknown'}));
});
