import assert from 'node:assert/strict';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

// Exercise the Railway Function including its authenticated HTTP handler. Supply
// the two imports locally so these tests never contact Railway or a renderer.
const source=readFileSync(new URL('../sandbox/railway-controller.ts',import.meta.url),'utf8')
  .replace(/^import .+ from .+;$/gm,'');
const controller=stripTypeScriptTypes(source,{mode:'transform'});
const image='sha256:fixture';
const ok={exitCode:0,timedOut:false,truncated:false,stdout:JSON.stringify({image,ready:true}),stderr:''};

function fixture(results,{networkIsolation='ISOLATED',domains=[],daemon=[ok]}={}){
  let handle;
  const calls={create:0,destroy:0,inspections:0,renders:0,pings:0,delays:0,logs:[]};
  const box={networkIsolation,domains,
    files:{async write(){}},
    async exec(command,options){
      if(command==='docker info --format "{{.ServerVersion}}"'){
        calls.pings++;
        return daemon.shift();
      }
      if(command==='python3 /opt/lemo/sandbox/railway_job.py render'){
        calls.renders++;
        return results.shift();
      }
      assert.equal(command,'python3 /opt/lemo/sandbox/railway_job.py ready');
      assert.ok(options.timeoutSec>=55);
      calls.inspections++;
      const result=results.shift();
      assert.ok(result,'unexpected probe');
      return result;
    },
    async destroy(){calls.destroy++;}
  };
  const env={RAILWAY_TOKEN:'fixture',LEMO_SANDBOX_CHECKPOINT:'fixture',LEMO_SANDBOX_IMAGE:image,
    LEMO_EXECUTOR_TOKEN:'fixture',LEMO_TLS_CERT:'fixture',LEMO_TLS_KEY:'fixture'};
  runInNewContext(controller,{
    Sandbox:{async create(_checkpoint,opts){calls.create++;assert.equal(opts.networkIsolation,'ISOLATED');return box;}},
    Bun:{env,serve(opts){if(opts.tls)handle=opts.fetch;},async sleep(){calls.delays++;}},
    Buffer,Response,URL,timingSafeEqual,console:{error(value){calls.logs.push(JSON.parse(value));}}
  });
  const ready=(token='fixture')=>handle(new Request('https://executor.invalid/ready',
    {headers:{authorization:'Bearer '+token}}),{timeout(){}});
  const render=()=>handle(new Request('https://executor.invalid/render',{method:'POST',
    headers:{authorization:'Bearer fixture'},body:JSON.stringify({html:'fixture',width:1080,height:1920,fps:30,duration:1})}),
    {timeout(){}});
  return {calls,ready,render};
}

test('a restored daemon may warm up once in the same isolated sandbox',async()=>{
  const first={...ok,exitCode:1};
  const {ready,calls}=fixture([ok],{daemon:[first,ok]});
  assert.deepEqual(await (await ready()).json(),{ready:true,image});
  assert.deepEqual(calls,{create:1,destroy:1,inspections:1,renders:0,pings:2,delays:1,logs:[]});
  const down=fixture([],{daemon:[first,first]});
  const response=await down.ready();
  assert.equal(response.status,503);
  assert.equal((await response.json()).code,'runtime_unavailable');
  assert.equal(down.calls.pings,2);
  assert.equal(down.calls.inspections,0);
});

test('waiting for Docker cannot repeat a submitted render',async()=>{
  const {render,calls}=fixture([{...ok,timedOut:true}],{daemon:[{...ok,exitCode:1},ok]});
  const response=await render();
  assert.equal(response.status,422);
  assert.equal(calls.pings,2);
  assert.equal(calls.renders,1);
  assert.equal(calls.destroy,1);
});

test('hard security failures do not run a second check or report ready',async()=>{
  for(const [result,opts,code] of [
    [ok,{networkIsolation:'PRIVATE'},'sandbox_network_policy'],
    [ok,{domains:['unexpected']},'sandbox_network_policy'],
    [{...ok,stdout:JSON.stringify({ready:true,image:'other'})},{},'renderer_image_mismatch'],
    [{...ok,stderr:'Kernel memory, swap or PID limit does not match the approved quota',exitCode:1},{},'runtime_limits_unverified'],
    [{...ok,stdout:'invalid response'},{},'runtime_probe_failed'],
  ]){
    const {ready,calls}=fixture([result],opts);
    const response=await ready();
    assert.equal(response.status,422);
    assert.deepEqual(await response.json(),{ready:false,code});
    assert.equal(calls.inspections,code==='sandbox_network_policy'?0:1);
    assert.equal(calls.delays,0);
    assert.equal(calls.destroy,1);
    assert.equal(calls.logs[0].code,code);
  }
});

test('auth denial never allocates a sandbox, and a timeout is a failed check',async()=>{
  const {ready,calls}=fixture([{...ok,timedOut:true}]);
  assert.equal((await ready('wrong')).status,401);
  assert.equal(calls.create,0);
  const response=await ready();
  assert.equal(response.status,503);
  assert.equal((await response.json()).code,'runtime_timeout');
  assert.equal(calls.destroy,1);
});
