import assert from 'node:assert/strict';
import {test} from 'node:test';
import {plannerCalls, plannerStatus, readPlannerCheckpoint, PlannerRecoveryError, type PlannerCheckpoint} from './planner-checkpoint.js';
import {OpenAIReadUnavailable} from './openai-response.js';
import {needsFreshPlannerConsent} from './legacy-planner-resume.js';

const receipt = (id: string, status = 'completed', extra: Record<string,unknown>={}) =>
  Response.json({id,status,output:[],usage:{input_tokens:9},...extra});
const opts = {apiKey:'mock',baseUrl:'http://provider.invalid',sleep:async()=>assert.fail('never sleep under the planner lock')};
const cp = (calls: PlannerCheckpoint['calls']={}): PlannerCheckpoint => ({version:1,provider:'openai',turn:0,calls});

test('one short request per step, schedules provider transitions and uses the same receipt after restart',async()=>{
  let checkpoint=cp(), now=20_000;
  const snapshots: PlannerCheckpoint[]=[], events:string[]=[], methods:string[]=[];
  const run=(fetch:typeof globalThis.fetch)=>plannerCalls(checkpoint, async event=>{
    snapshots.push(structuredClone(checkpoint));if(event)events.push(event);
  }).openai('main')({}, {...opts,now:()=>now,fetch});
  await assert.rejects(run(async(_url,init)=>{
    methods.push(String(init?.method));
    assert.ok(Object.hasOwn(snapshots[0].calls,'main'));
    assert.equal(snapshots[0].calls.main.response_id,undefined);
    return receipt('resp_main','queued');
  }),OpenAIReadUnavailable);
  assert.deepEqual(methods,['POST']);
  assert.equal(snapshots[1].calls.main.response_id,'resp_main');
  assert.equal(checkpoint.wait?.next_poll_at,30_000);
  assert.equal(plannerStatus('writing',checkpoint.wait,now)?.label,'รอคิว OpenAI');

  checkpoint=structuredClone(snapshots.at(-1)!);
  await assert.rejects(run(async()=>assert.fail('poll not due')),OpenAIReadUnavailable);
  now+=10_000;
  const poll=(status:string)=>run(async(url,init)=>{
    methods.push(String(init?.method));
    assert.match(String(url),/\/resp_main$/);
    return receipt('resp_main',status);
  });
  await assert.rejects(poll('queued'),OpenAIReadUnavailable);
  assert.equal(events.filter(x=>x==='รอคิว OpenAI').length,1);
  now+=10_000;
  await assert.rejects(poll('in_progress'),OpenAIReadUnavailable);
  assert.deepEqual(plannerStatus('writing',checkpoint.wait,now),{
    phase:'in_progress',label:'OpenAI กำลังเขียน',provider_status:'in_progress',started_at:20_000,checked_at:40_000,next_poll_at:50_000,
  });
  now+=20*60_000;
  await assert.rejects(poll('in_progress'),OpenAIReadUnavailable);
  assert.equal(plannerStatus('writing',checkpoint.wait,now)?.phase,'slow');
  assert.ok(events.includes('รอนานผิดปกติ · กำลังตรวจงานเดิม'));
  now+=10_000;
  const result=await poll('completed');
  assert.equal(result.usage.input_tokens,9);
  assert.equal(checkpoint.wait,undefined);
  assert.equal((await run(async()=>assert.fail('replaying completed step uses its stored result'))).id,'resp_main');
  assert.deepEqual(methods,['POST','GET','GET','GET','GET']);
});

test('ambiguous POST or failed intent write cannot reissue a paid operation',async()=>{
  let wire=0;
  const disconnected=async()=>{wire++;throw Error('disconnected');};
  const checkpoint=cp();
  await assert.rejects(plannerCalls(checkpoint,async()=>{}).openai('research_1')({}, {...opts,fetch:disconnected}),PlannerRecoveryError);
  assert.equal(checkpoint.wait?.state,'uncertain');
  assert.equal(needsFreshPlannerConsent({status:'failed',planner_checkpoint:checkpoint}),true);
  await assert.rejects(plannerCalls(structuredClone(checkpoint),async()=>{}).openai('research_1')({}, {...opts,fetch:disconnected}),/ไม่มีรหัสตอบกลับ/);
  await assert.rejects(plannerCalls(cp(),async()=>{throw Error('DB down');}).openai('main')({}, {...opts,fetch:disconnected}),PlannerRecoveryError);
  assert.equal(wire,1);
});

test('transient GET failures back off, but terminal provider failure and definitive POST rejection do not',async()=>{
  const old=cp({main:{response_id:'resp_saved'}});
  const methods:string[]=[];
  let now=20_000;
  const attempt=(reply:()=>Response)=>plannerCalls(old,async()=>{}).openai('main')({}, {...opts,now:()=>now,fetch:async(url,init)=>{
    methods.push(String(init?.method));assert.match(String(url),/\/resp_saved$/);return reply();
  }});
  await assert.rejects(attempt(()=>new Response('<gateway>',{status:503})),OpenAIReadUnavailable);
  assert.equal(old.wait?.state,'retry_read');
  assert.equal(old.wait?.next_poll_at,30_000);
  now=30_000;
  await assert.rejects(attempt(()=>new Response('<gateway>',{status:429})),OpenAIReadUnavailable);
  assert.equal(old.wait?.next_poll_at,50_000);
  now=50_000;
  await assert.rejects(attempt(()=>receipt('resp_saved','failed',{error:{code:'content_policy'}})),/content_policy/);
  assert.equal(old.wait?.state,'failed');
  assert.equal(old.wait?.next_poll_at,undefined);
  await assert.rejects(attempt(()=>assert.fail('terminal receipt does not need another poll')),/content_policy/);
  assert.deepEqual(methods,['GET','GET','GET']);
  const rejected=cp();
  let posts=0;
  await assert.rejects(plannerCalls(rejected,async()=>{}).openai('main')({}, {...opts,fetch:async()=>{
    posts++;return Response.json({error:{code:'rate_limit'}},{status:429});
  }}),/HTTP 429/);
  assert.equal(rejected.wait?.state,'failed');
  assert.equal(needsFreshPlannerConsent({status:'failed',planner_checkpoint:rejected}),false);
  assert.equal(posts,1);
});

test('mismatched response, permanent refusal to read and provider cancellation keep distinct states',async()=>{
  for (const [reply,state] of [
    [()=>receipt('resp_other'),'blocked'],
    [()=>new Response('not found',{status:404}),'blocked'],
    [()=>receipt('resp_saved','cancelled'),'cancelled'],
  ] as const) {
    const checkpoint=cp({main:{response_id:'resp_saved'}});
    await assert.rejects(plannerCalls(checkpoint,async()=>{}).openai('main')({}, {...opts,fetch:async(_url,init)=>{
      assert.equal(init?.method,'GET');return reply();
    }}),PlannerRecoveryError);
    assert.equal(checkpoint.wait?.state,state);
  }
});

test('an old checkpoint is read using the original response ID and incomplete still feeds the repair flow',async()=>{
  const checkpoint={...cp({main:{response_id:'resp_legacy'}}),legacy:true as const};
  assert.equal(readPlannerCheckpoint(checkpoint,'openai'),checkpoint);
  const result=await plannerCalls(checkpoint,async()=>{}).openai('main')({}, {...opts,fetch:async(url,init)=>{
    assert.equal(init?.method,'GET');assert.match(String(url),/resp_legacy$/);return receipt('resp_legacy','incomplete');
  }});
  assert.equal(result.status,'incomplete');
});

test('foreground planner saves the response before applying tools and holds an ambiguous dispatch',async()=>{
  const checkpoint=cp();let posts=0;
  const result=await plannerCalls(checkpoint,async()=>{}).foreground('main',async()=>{posts++;return {content:['answer']};});
  assert.deepEqual(await plannerCalls(structuredClone(checkpoint),async()=>{assert.fail();}).foreground('main',async()=>{posts++;}),result);
  await assert.rejects(plannerCalls(cp({main:{}}),async()=>{}).foreground('main',async()=>{posts++;}),PlannerRecoveryError);
  assert.equal(posts,1);
});

test('rejects unreadable checkpoints and incompatible providers before generating',()=>{
  assert.equal(readPlannerCheckpoint(null,'openai'),undefined);
  for(const record of [{},{version:1,provider:'anthropic',turn:0,state:{},calls:{}},{version:1,provider:'openai',legacy:true,turn:0,calls:{}}]) {
    assert.throws(()=>readPlannerCheckpoint(record,'openai'),PlannerRecoveryError);
  }
});
