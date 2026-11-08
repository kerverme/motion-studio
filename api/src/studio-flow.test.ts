import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

// Provider configuration is read on module load. No external requests are made.
process.env.MOTION_LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'mock-key';
process.env.MOTION_OPENAI_WEB_SEARCH = 'true';
delete process.env.FIRECRAWL_API_KEY;
const { registerStudio, Draft } = await import('./studio.js');

for (const repair of [false,true]) test(repair ? 'missing source repair delivers evidence before metadata can become ready' : 'pump saves one actor and shot at a time, then requires a later preview review turn', async () => {
  const script = [
    { id: 'open', beat: 'hook', text: 'คนชื่อ เบล ในประเทศไทย มีกี่คน' },
    ...['market', 'glasses', 'monkey', 'reveal'].map(id => ({ id, beat: 'rehook', text: 'แต่เดี๋ยวก่อน เรื่องของเบลยังไม่จบ เราจะตามไปดูที่ตลาด เมื่อแว่นหายไปแล้วใครกันที่เก็บได้ ลองสังเกตคนรอบตัวให้ดี เพราะคำตอบอาจอยู่ใกล้กว่าที่คิด' })),
    { id: 'end', beat: 'cta', text: 'ถ้าคุณเป็นเบล จะเริ่มตามหาจากตรงไหน ลองเล่าในคอมเมนต์ให้ฟังหน่อย' },
  ];
  const plan = { script, shots: script.map(s => ({ seg: s.id, visual: 'Market scene with a monkey and the missing glasses', action: 'Bell reaches for glasses', camera: 'Medium tracking shot', characters: ['เบล'] })), character_notes: 'Bell has a long face and distinct hairline.' };
  const submitted = Draft.parse({ title_th: 'แว่นของเบลหายไปไหน', format: 'mystery', script,
    scenes: script.map(s => ({ seg: s.id, type: 'custom', code: 'def draw(c,t,p):\n  c.grad("sky","cream")\n  c.person("เบล",450,700,250)' })),
    art: 'def ground(c):\n  c.rect(0,1200,1080,720,"cream")',
    cast: [{ name: 'เบล', portrait_code: 'def draw(c,t,p):\n  c.ellipse(0,0,80,110,"tan")' }],
    sources: [{ url: 'https://example.org/research', publisher: 'Example', published: String(new Date().getUTCFullYear()), claim: 'ไม่มีข้อมูลจำนวนคนชื่อเบล', confidence: 'low' }],
    claims: [{ text: 'เบลเป็นชื่อของตัวละครสมมติ', kind: 'assumption', source_ids: [] }],
    captions: { facebook: 'เบล', instagram: 'เบล', tiktok: 'เบล', youtube: 'เบล', twitter: 'เบล' },
  });
  const look = { hairstyle: 'short', hair_color: [20, 25, 30], skin: [200, 150, 120], top: 'shirt', top_color: [5, 70, 160], bottom: 'pants', bottom_color: [10, 10, 10], glasses: 'none', accessories: [], accessory_color: [0, 0, 0] };
  let status = 'queued', calls = 0, previews = 0, finalAtCall = 0, persistedPlan: unknown, finalDraft: any, verificationCalls = 0;
  const checkpoints: any[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const row = { id: '10000000-0000-0000-0000-000000000001', topic: 'เรื่องเบล', model: 'gpt-6-astra', reasoning: 'high', characters: [{ id: '20000000-0000-0000-0000-000000000001', name: 'เบล', look }], style: 'classic', auto_produce: false };
  const requests: any[] = [];
  let fetchError: unknown;
  const sql: string[] = [];
  const pool = { query: async (query: string, args: any[] = []) => {
    sql.push(query);
    if (query.includes("WHERE status IN ('researching','writing')")) return { rows: [], rowCount: 0 };
    if (query.includes("SELECT id FROM drafts WHERE status='queued'")) return { rows: status === 'queued' ? [{ id: row.id }] : [] };
    if (query.startsWith('SELECT * FROM drafts WHERE id=')) return { rows: [{ ...row, status }] };
    if (query.startsWith('SELECT id, draft FROM drafts')) return { rows: [] };
    if (query.startsWith('SELECT reference_image, thumb')) return { rows: [{ reference_image: 'data:image/jpeg;base64,cmVmZXJlbmNl', thumb: null }] };
    if (query.startsWith('INSERT INTO art_checks')) {
      previews++; assert.equal(calls >= 11, true, 'cannot preview before all incremental assets are saved');
      const payload = JSON.parse(args[1]);
      assert.equal(JSON.stringify(payload).includes('cmVmZXJlbmNl'), false, 'original photos stay out of worker payload');
      assert.ok(payload.cast[0].portrait_code);
      return { rows: [{ id: `check-${previews}` }] };
    }
    if (query.startsWith('SELECT status, result FROM art_checks')) return { rows: [{ status: 'done', result: { scenes: script.map(s => ({ seg: s.id, errors: [], frames: ['ZnJhbWU=', 'ZnJhbWU='] })) } }] };
    if (query.startsWith('UPDATE drafts SET artwork=')) { checkpoints.push(JSON.parse(args[1])); return {rows:[],rowCount:1}; }
    if (query.startsWith('UPDATE drafts SET storyboard=')) { persistedPlan = JSON.parse(args[1]); status = 'writing'; }
    else if (query.startsWith("UPDATE drafts SET status='researching'")) status = 'researching';
    else if (query.startsWith("UPDATE drafts SET status='writing'")) status = 'writing';
    else if (query.startsWith('UPDATE drafts SET draft=')) { status = args[4]; finalDraft = JSON.parse(args[1]); finalAtCall = calls; resolveDone(); }
    else if (query.startsWith("UPDATE drafts SET status='failed'")) { status = 'failed'; resolveDone(); }
    else if (!query.startsWith('UPDATE drafts SET log') && !query.startsWith('UPDATE drafts SET usage') && !query.startsWith('UPDATE drafts SET problems')) throw new Error('Unexpected SQL: ' + query);
    return { rows: [], rowCount: 1 };
  } };
  const nativeFetch = globalThis.fetch, nativeTimeout = globalThis.setTimeout;
  const timeout = nativeTimeout(() => resolveDone(), 5000);
  const tool = (name: string, input: unknown, id: string) => ({ type: 'function_call', name, call_id: id, arguments: JSON.stringify(input) });
  globalThis.fetch = async (_url, init) => {
    try {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if(String(body.instructions).startsWith('You verify source pages')) {
      verificationCalls++;
      return new Response(JSON.stringify({id:'resp_verify',status:'completed',output:[{type:'web_search_call',status:'completed',action:{type:'open_page',url:'https://official.example/new-data'}},{type:'message',status:'completed',content:[{type:'output_text',text:'SOURCE CHECK: no official nickname count is published.'}]}],usage:{input_tokens:50,output_tokens:20}}),{status:200});
    }
    calls++;
    assert.equal(body.background, true);
    assert.equal(body.parallel_tool_calls, false);
    assert.ok(body.max_tool_calls <= 3);
    assert.equal(body.max_output_tokens, calls <= 2 ? 24000 : 16000);
    assert.equal(body.reasoning.effort, calls <= 2 ? 'high' : 'medium');
    if (calls >= 3) { const submit = body.tools.find((t:any)=>t.name==='submit_episode'); for (const key of ['script','cast','scenes','art']) assert.equal(key in submit.parameters.properties,false); }
    let output: any[];
    if (calls === 1) output = [tool('submit_episode', submitted, 'too-early')];
    else if (calls === 2) {
      assert.ok(body.input.some((i: any) => i.type === 'function_call_output' && i.call_id === 'too-early' && i.output.includes('First call plan_story')));
      output = [{ type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.org/research' } }, tool('plan_story', plan, 'plan')];
    } else if (calls === 3) output = [tool('draw_character', {character:{...submitted.cast[0],portrait_description:'A long-faced person with a distinct hairline'}}, 'actor')];
    else if (calls === 4) output = [tool('save_art', {art:submitted.art}, 'helpers')];
    else if (calls >= 5 && calls <= 10) output = [tool('draw_scene', {scene:submitted.scenes[calls-5]}, 'scene-'+calls)];
    else if (calls === 11) {
      const {art,cast,scenes,script:lockedScript,...metadata}=submitted;
      assert.equal(checkpoints.at(-1).scenes.length,6);
      output = [tool('submit_episode',metadata,'draw-a'),tool('submit_episode',metadata,'draw-b')];
    } else if (calls === 12) {
      assert.equal(status, 'writing', 'two submits in the same turn must not bypass visual review');
      const shown = body.input.filter((i: any) => i.role === 'user' && Array.isArray(i.content) && i.content[0]?.text.startsWith('Preview frames'));
      assert.equal(shown.length, 1);
      assert.equal(shown[0].content.filter((c: any) => c.type === 'input_image').length, script.length * 2);
      const {art,cast,scenes,script:lockedScript,...metadata}=submitted;
      assert.equal(body.input.filter((i:any)=>i.type==='function_call_output').some((i:any)=>i.output.includes('was not retrieved')),false,'completed open_page is accepted research evidence');
      if(repair){
        const revised={...metadata,sources:[{...metadata.sources[0],url:'https://official.example/new-data'}]};
        output=[tool('submit_episode',revised,'source-a'),tool('submit_episode',revised,'source-b')];
      }else output = [tool('submit_episode', metadata, 'reviewed')];
    } else if(calls===13 && repair){
      assert.equal(status,'writing','duplicate submit cannot bypass evidence delivery');
      assert.equal(verificationCalls,1);
      assert.ok(body.input.some((i:any)=>i.type==='function_call_output'&&i.call_id==='source-a'&&i.output.includes('SOURCE CHECK')));
      assert.ok(body.input.some((i:any)=>i.type==='function_call_output'&&i.call_id==='source-b'&&i.output.includes('SOURCE REVIEW')));
      const {art,cast,scenes,script:lockedScript,...metadata}=submitted;
      output=[tool('submit_episode',{...metadata,sources:[{...metadata.sources[0],url:'https://official.example/new-data'}],captions:{...metadata.captions,facebook:'ตรวจแล้วไม่มีสถิติทางการของชื่อเบล'}},'source-reviewed')];
    } else throw new Error('Unexpected model turn ' + calls);
    return new Response(JSON.stringify({ id: `resp_${calls}`, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 100 } }), { status: 200 });
    } catch (e) { fetchError = e; throw e; }
  };
  // Accelerate only app preview polling; suppress startup inbox import in this isolated test.
  globalThis.setTimeout = ((callback: (...a: any[]) => void, ms?: number, ...args: any[]) =>
    nativeTimeout(ms === 8000 ? () => {} : callback, ms === 1500 || ms === 8000 ? 0 : ms, ...args)) as typeof setTimeout;
  try {
    registerStudio(new Hono(), pool as any, { guard: async (_c, next) => next(),
      createJob: async () => { throw new Error('must not auto-produce'); }, estimateCredits: () => 100,
      validate: () => [], researchFreshness: () => [],
    });
    await done;
    if (fetchError) throw fetchError;
    assert.equal(status, 'ready');
    assert.equal(finalAtCall, repair?13:12);
    assert.equal(verificationCalls,repair?1:0);
    if(repair)assert.equal(finalDraft.sources[0].url,'https://official.example/new-data');
    assert.ok(checkpoints.length >= 9);
    assert.equal(checkpoints.at(-1).cast[0].portrait_code,submitted.cast[0].portrait_code);
    assert.equal(checkpoints.at(-1).scenes.length,6);
    assert.equal(previews, 3);
    assert.deepEqual(persistedPlan, plan);
    assert.deepEqual(finalDraft.storyboard, plan);
    assert.ok(requests[0].input.some((i: any) => Array.isArray(i.content) && i.content.some((c: any) => c.image_url === 'data:image/jpeg;base64,cmVmZXJlbmNl')));
  } finally {
    clearTimeout(timeout); globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeTimeout;
  }
});

test('a provider timeout keeps completed scene checkpoints and retry copies them', async () => {
  const script = ['open','first','second','end'].map((id,i) => ({id,text:'เรื่องของเบลในประเทศไทย',beat:i===0?'hook':i===3?'cta':'info'}));
  const plan = {script,shots:script.map(s=>({seg:s.id,visual:'A newly drawn street scene',action:'Walks down the street',camera:'Medium shot',characters:['เบล']})),character_notes:'A long face with a distinctive hairline'};
  const portrait = {name:'เบล',portrait_description:'A long face',portrait_code:'def draw(c,t,p):\n  c.ellipse(0,0,80,110,"tan")'};
  let status='queued', calls=0, cancelled=0, artwork:any, savedPlan:any, lastError='', copied:any;
  const row:any={id:'10000000-0000-0000-0000-000000000002',topic:'เรื่องเบล',model:'gpt-6-astra',reasoning:'high',characters:[],style:'classic',auto_produce:false};
  let resolveDone!:()=>void;
  const done=new Promise<void>(resolve=>{resolveDone=resolve;});
  const pool={query:async(query:string,args:any[]=[])=>{
    if(query.includes("WHERE status IN ('researching','writing')"))return{rows:[],rowCount:0};
    if(query.includes("SELECT id FROM drafts WHERE status='queued'"))return{rows:status==='queued'?[{id:row.id}]:[]};
    if(query.startsWith('SELECT * FROM drafts WHERE id='))return{rows:[{...row,status,storyboard:savedPlan,artwork}]};
    if(query.startsWith('SELECT id, draft FROM drafts'))return{rows:[]};
    if(query.startsWith('INSERT INTO drafts'))return{rows:[{id:'10000000-0000-0000-0000-000000000003'}]};
    if(query.startsWith('UPDATE drafts SET storyboard=$2, artwork=')){copied={plan:JSON.parse(args[1]),artwork:JSON.parse(args[2])};return{rows:[],rowCount:1};}
    if(query.startsWith('UPDATE drafts SET artwork='))artwork=JSON.parse(args[1]);
    if(query.startsWith('UPDATE drafts SET storyboard=')){savedPlan=JSON.parse(args[1]);status='writing';}
    if(query.startsWith("UPDATE drafts SET status='researching'"))status='researching';
    if(query.startsWith("UPDATE drafts SET status='failed'")){status='failed';lastError=args[1];resolveDone();}
    return{rows:[],rowCount:1};
  }};
  const nativeFetch=globalThis.fetch,nativeTimeout=globalThis.setTimeout,nativeNow=Date.now;
  let fakeNow=nativeNow();
  const timeout=nativeTimeout(resolveDone,5000);
  const tool=(name:string,input:unknown,id:string)=>({type:'function_call',name,call_id:id,arguments:JSON.stringify(input)});
  const app=new Hono();
  let fetchError:unknown;
  globalThis.fetch=async(url,init)=>{
    try{
      if(String(url).endsWith('/cancel')){cancelled++;return new Response(JSON.stringify({status:'cancelled'}),{status:200});}
      calls++;
      const body=JSON.parse(String(init?.body));
      assert.equal(body.background,true);
      const output=calls===1?[tool('plan_story',plan,'plan')]:calls===2?[tool('draw_character',{character:portrait},'actor')]:
        calls===3||calls===4?[tool('draw_scene',{scene:{seg:script[calls-3].id,type:'custom',code:'def draw(c,t,p):\n  c.person("เบล",540,600,240)'}},'shot-'+calls)]:[];
      if(calls===5)return new Response(JSON.stringify({id:'resp_timeout',status:'in_progress'}),{status:200});
      return new Response(JSON.stringify({id:'resp_'+calls,status:'completed',output,usage:{input_tokens:10,output_tokens:10}}),{status:200});
    }catch(e){fetchError=e;throw e;}
  };
  Date.now=()=>fakeNow;
  globalThis.setTimeout=((callback:(...args:any[])=>void,ms?:number,...args:any[])=>{
    if(ms===3000){fakeNow+=24*3600_000;return nativeTimeout(callback,0,...args);}
    return nativeTimeout(ms===8000?()=>{}:callback,ms===8000||ms===1500?0:ms,...args);
  }) as typeof setTimeout;
  try{
    registerStudio(app,pool as any,{guard:async(_c,next)=>next(),createJob:async()=>{throw new Error('must not produce');},estimateCredits:()=>100,validate:()=>[],researchFreshness:()=>[]});
    await done;
    if(fetchError)throw fetchError;
    assert.equal(status,'failed');
    assert.equal(calls,5,'does not create a duplicate provider response after timeout');
    assert.equal(cancelled,1);
    assert.match(lastError,/เกินเวลารอต่อรอบ/);
    assert.equal(artwork.scenes.length,2);
    assert.equal(artwork.cast[0].portrait_code,portrait.portrait_code);
    const response=await app.request('/app/api/studio/drafts/'+row.id+'/rewrite',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,201);
    assert.deepEqual(copied.plan,plan);
    assert.equal(copied.artwork.scenes.length,2,'retry resumes completed scenes');
  }finally{
    clearTimeout(timeout);globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeTimeout;Date.now=nativeNow;
  }
});
