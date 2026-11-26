import assert from 'node:assert/strict';
import {test} from 'node:test';
import {plannerCalls, readPlannerCheckpoint, PlannerRecoveryError} from './planner-checkpoint.js';
import {OpenAIReadUnavailable} from './openai-response.js';

const receipt = (id: string, status = 'completed') => Response.json({id,status,output:[],usage:{input_tokens:9}});
const opts = {apiKey:'mock',baseUrl:'http://provider.invalid',sleep:async()=>{}};

test('writes intent before POST and response ID before progress, then reads exactly the stored ID on restart',async()=>{
  const calls: Record<string,{}> = {}, snapshots: any[] = [];
  const journal=plannerCalls(calls,async()=>{snapshots.push(structuredClone(calls));});
  const wire: string[]=[];
  const request = journal.openai('main');
  await request({}, {...opts,fetch:async(url,init)=>{
    wire.push(String(init?.method));
    if (init?.method==='POST') {
      assert.deepEqual(snapshots,[{main:{}}]);
      return receipt('resp_main','queued');
    }
    assert.deepEqual(snapshots.at(-1),{main:{response_id:'resp_main'}});
    assert.match(String(url),/\/resp_main$/);
    return receipt('resp_main');
  },onProgress:async()=>{assert.equal(snapshots.at(-1).main.response_id,'resp_main');}});
  const restarted=plannerCalls(structuredClone(snapshots.at(-1)),async()=>{assert.fail('already has receipt');});
  const result=await restarted.openai('main')({}, {...opts,fetch:async(url,init)=>{
    wire.push(String(init?.method));assert.match(String(url),/\/resp_main$/);return receipt('resp_main');
  }});
  assert.equal(result.usage.input_tokens,9);
  assert.deepEqual(wire,['POST','GET','GET']);
});

test('unknown receipt or failed intent write cannot reissue a paid operation',async()=>{
  let wire=0;
  const disconnected=async()=>{wire++;throw Error('disconnected');};
  const calls:Record<string,{}>={};
  await assert.rejects(plannerCalls(calls,async()=>{}).openai('research_1')({}, {...opts,fetch:disconnected}),PlannerRecoveryError);
  assert.deepEqual(calls,{research_1:{}});
  await assert.rejects(plannerCalls(structuredClone(calls),async()=>{}).openai('research_1')({}, {...opts,fetch:disconnected}),/ไม่มีรหัสตอบกลับ/);
  await assert.rejects(plannerCalls({},async()=>{throw Error('DB down');}).openai('main')({}, {...opts,fetch:disconnected}),PlannerRecoveryError);
  assert.equal(wire,1);
});

test('durable reads yield the scheduler on deadline or read outage and reject a mismatched receipt',async()=>{
  for(const mode of ['pending','outage','mismatch']){
    const wire:string[]=[];let now=0;
    const run=plannerCalls({search:{response_id:'resp_saved'}},async()=>{assert.fail();}).openai('search');
    await assert.rejects(run({}, {...opts,responseId:'resp_saved',now:()=>now,timeoutMs:100,sleep:async(ms)=>{now+=ms;},
      fetch:async(url,init)=>{
        assert.match(String(url),/\/resp_saved$/);wire.push(String(init?.method));
        if(mode==='outage')return Response.json({error:{}},{status:503});
        return receipt(mode==='mismatch'?'resp_other':'resp_saved',mode==='pending'?'queued':'completed');
      }}),mode==='mismatch'?PlannerRecoveryError:OpenAIReadUnavailable);
    assert.ok(wire.every(method=>method==='GET'));
  }
});

test('foreground planner saves the response before applying tools and holds an ambiguous dispatch',async()=>{
  const calls:Record<string,{}>={};let posts=0;
  const result=await plannerCalls(calls,async()=>{}).foreground('main',async()=>{posts++;return {content:['answer']};});
  assert.deepEqual(await plannerCalls(structuredClone(calls),async()=>{assert.fail();}).foreground('main',async()=>{posts++;}),result);
  await assert.rejects(plannerCalls({main:{}},async()=>{}).foreground('main',async()=>{posts++;}),PlannerRecoveryError);
  assert.equal(posts,1);
});

test('rejects unreadable checkpoints and incompatible providers before generating',()=>{
  assert.equal(readPlannerCheckpoint(null,'openai'),undefined);
  for(const record of [{},{version:1,provider:'anthropic',turn:0,state:{},calls:{}},{version:1,provider:'openai',legacy:true,turn:0,calls:{}}]) {
    assert.throws(()=>readPlannerCheckpoint(record,'openai'),PlannerRecoveryError);
  }
});
