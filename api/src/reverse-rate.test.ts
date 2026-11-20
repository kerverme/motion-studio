import test from 'node:test';
import assert from 'node:assert/strict';
import {currentReverseRate} from './reverse-rate.js';

test('expired reverse rates renew only from matching official units and are cached for subsequent quotes',async()=>{
  const now=Date.parse('2026-11-20T12:00:00Z'),model='gpt-6.2-sol';
  const rate={model,currency:'USD',source:'https://developers.openai.com/api/docs/models/'+model,checked_at:'2026-11-01T00:00:00Z',
    valid_until:'2026-11-08T00:00:00Z',input_per_million:2,cache_write_per_million:2.5,output_per_million:10};
  let record:any=null,calls=0;
  const db={query:async(sql:string,args:any[])=>{
    if(sql.startsWith('SELECT'))return {rows:record?[{data:record}]:[]};
    record=JSON.parse(args[1]);return {rows:[]};
  }};
  const markdown='### Text tokens\n| Input | $2 | 1M tokens |\n| Cache writes | $2.5 | 1M tokens |\n| Output | $10 | 1M tokens |\n30 minutes of retention. For requests with more than 272K input tokens, input and cache rates double and output costs 1.5 times the short-context rate.';
  const read=async(input:any)=>{calls++;assert.equal(input,rate.source+'.md');return new Response(markdown);};
  const snapshot=await currentReverseRate(db,JSON.stringify(rate),rate,model,read,now);
  assert(Date.parse(snapshot.valid_until)>now);assert.equal(snapshot.output_per_million,10);
  assert.deepEqual(await currentReverseRate(db,JSON.stringify(rate),rate,model,read,now),snapshot);assert.equal(calls,1);
  record=null;
  for(const altered of [markdown.replace('$10','$12'),markdown.replaceAll('1M tokens','minute'),markdown.replace('Text tokens','Audio tokens')])
    await assert.rejects(currentReverseRate(db,JSON.stringify(rate),rate,model,async()=>new Response(altered),now),/ราคา/);
  assert.equal(record,null);
  const valid={...rate,valid_until:'2027-01-01T00:00:00Z'};
  assert.deepEqual(await currentReverseRate(db,JSON.stringify(valid),valid,model,read,now),valid);assert.equal(calls,1);
  await assert.rejects(currentReverseRate(db,JSON.stringify(rate),valid,model,read,now));assert.equal(calls,1);
  const speech={...rate,model:'gpt-transcribe',source:'https://developers.openai.com/api/docs/models/gpt-transcribe',per_minute:.0045};
  assert.equal((await currentReverseRate(db,JSON.stringify(speech),speech,speech.model,async()=>new Response('### Transcription audio duration\n| Price | $0.0045 | minute |'),now)).per_minute,.0045);
});
