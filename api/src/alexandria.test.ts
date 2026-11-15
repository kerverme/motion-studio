import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Script} from 'node:vm';
import {Hono} from 'hono';
import {PGlite} from '@electric-sql/pglite';
import {Alexandria,pricedTool,verifyResearchModel,type Tool} from './trends/alexandria.js';
import {PgResearchBudget,BudgetedFirecrawl} from './firecrawl-budget.js';
import {normaliseSocial,recentEvidence,assessPattern,type Assessment} from './trends/evidence.js';
import {runResearch,webEvidence} from './trends/orchestrator.js';
import {registerTrendRoutes} from './trends/routes.js';
import {eligibleTrends,selectedContext} from './trends/store.js';
import {parseDetailedIdeas} from './topic-suggestions.js';
import {notionProperties} from './trends/notion.js';

const db=new PGlite();const query=(sql:string,args:any[]=[])=>db.query(sql,args);
const pool:any={query,connect:async()=>({query,release(){}})};
const catalog:Tool[]=JSON.parse(readFileSync(new URL('./trends/fixtures/catalog-2026-11-15.json',import.meta.url),'utf8'));
const tool=catalog.find(t=>t.capability==='tiktok/search-videos')!;
const nativeFetch=globalThis.fetch,originalEnv={...process.env};
before(async()=>{for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));});
after(async()=>{globalThis.fetch=nativeFetch;process.env=originalEnv;await db.close();});
const response=(capability:string,data:any,credits=2)=>Response.json({success:true,data:{alexandria:[{provider:capability==='find-tools'?'firecrawl':'scrapecreators',capability,creditsCost:credits,data}]}});
async function job(){const id=randomUUID(),budgetId=randomUUID();await query("INSERT INTO trend_research_runs(id,request_key,request,status) VALUES($1::uuid,$1::text,'{}','running')",[id]);await query('INSERT INTO research_jobs(id) VALUES($1)',[budgetId]);await query('INSERT INTO trend_alexandria_jobs(run_id,request_id,request_hash,budget_id) VALUES($1::uuid,$1::uuid,$1::text,$2)',[id,budgetId]);return {id,budgetId,store:new PgResearchBudget(pool)};}
const observed=new Date().toISOString(),published=Math.floor((Date.now()-3600000)/1000);
const payload={search_item_list:[1,2].map(i=>({aweme_info:{aweme_id:String(810000000+i),author:{unique_id:'creator'+i},desc:'ทดลองแรงตึงผิว น้ำกับพริกไทย ทำไมพริกไทยหนีสบู่',create_time:published,statistics:{play_count:1000000,digg_count:50000,comment_count:500}}}))};
const evidence=normaliseSocial(tool.capability,payload,observed);
const assessment:Assessment={title:'พริกไทยหนีสบู่ได้อย่างไร',category:'วิทยาศาสตร์ใกล้ตัว',summary:'พบผู้สร้างหลายรายทดลองแรงตึงผิว',reason:'มีการทดลองเรื่องเดียวกันจากผู้สร้างสองราย',relevance:95,novelty:90,source_ids:evidence.map(e=>e.platform+':'+e.sourceId),quotes:evidence.map(e=>({source_id:e.platform+':'+e.sourceId,quote:'ทดลองแรงตึงผิว'})),angles:['การทดลองที่บ้าน']};
test('official discovery is authenticated, free, expanded and rejects login failure without a paid call',async()=>{
 let calls=0;const api=new Alexandria({apiKey:'test-secret',fetch:async(_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer test-secret');const body=JSON.parse(String(init?.body));assert.equal(body.alexandria.provider,'firecrawl');assert.equal(body.alexandria.capability,'find-tools');assert.deepEqual(body.alexandria.options.expand,['options','response']);return response('find-tools',{items:catalog,total:catalog.length,next:null},0);}});
 assert.equal((await api.discover('scrapecreators')).length,catalog.length);assert.equal(calls,1);
 let failures=0;await assert.rejects(new Alexandria({apiKey:'x',fetch:async()=>{failures++;return Response.json({success:false},{status:401});}}).discover('scrapecreators'),/HTTP 401/);assert.equal(failures,1);
});
test('unknown pricing, per-record fees, changed maximum and unsupported options stop before dispatch',()=>{
 assert.equal(pricedTool(tool,{query:'ไทย'}).maximum,2);
 for(const changed of [{...tool,creditsCost:3},{...tool,perRecord:true},{...tool,billing:undefined},{...tool,billing:{maxCredits:30}},{...tool,provider:'oriane'},{...tool,capability:'unreviewed'}])assert.throws(()=>pricedTool(changed,{query:'ไทย'}));
 assert.throws(()=>pricedTool(tool,{query:'ไทย',limit:100}));assert.throws(()=>pricedTool(tool,{query:'ไทย',date_posted:'made-up'}));
});
test('mixed legacy and Alexandria calls share one durable 25-credit limit, including after restart',async()=>{
 const j=await job();let calls=0;const fc=new BudgetedFirecrawl(j.store,{apiKey:'mock',baseUrl:'https://test',fetch:async()=>Response.json({success:true,creditsUsed:1,data:{markdown:'real source',metadata:{sourceURL:'https://example.org/source'}}})});
 await fc.request(j.budgetId,'/v2/scrape',{url:'https://example.org/source'},{webAttempted:true,reason:'The web source is missing a necessary table'});
 const api=new Alexandria({apiKey:'mock',fetch:async(_url,init)=>{calls++;assert.ok((await j.store.snapshot(j.budgetId)).committed<=25);return response('tiktok/search-videos',{items:[]});}});
 for(let i=0;i<11;i++)await api.execute(j.store,j.budgetId,tool,{query:'ไทย '+i},true);
 assert.equal((await j.store.snapshot(j.budgetId)).committed,25);
 await assert.rejects(api.execute(new PgResearchBudget(pool),j.budgetId,tool,{query:'over budget'},true));assert.equal(calls,11);
 await assert.rejects(j.store.approve(j.budgetId,100),/hard 25 credit limit/);
});
test('cache and retry never duplicate paid calls and preserve collection time',async()=>{
 const j=await job();let calls=0;const api=new Alexandria({apiKey:'mock',fetch:async()=>{calls++;return response('tiktok/search-videos',payload);}});
 const a=await api.execute(j.store,j.budgetId,tool,{query:'cache test'},true);const b=await api.execute(new PgResearchBudget(pool),j.budgetId,tool,{query:'cache test'},true);
 assert.equal(calls,1);assert.equal(b.cache_hit,true);assert.equal(b.credits,0);assert.ok(Math.abs(Date.parse(String(a.collected_at))-Date.parse(String(b.collected_at)))<1000);
});
test('ambiguous timeout keeps reservation and prevents another charge; web-first cannot be skipped',async()=>{
 const j=await job();let calls=0;const api=new Alexandria({apiKey:'mock',fetch:async()=>{calls++;throw new Error('timeout');}});
 await assert.rejects(api.execute(j.store,j.budgetId,tool,{query:'no web'},false));assert.equal(calls,0);
 await assert.rejects(api.execute(j.store,j.budgetId,tool,{query:'timeout'},true));
 await assert.rejects(api.execute(new PgResearchBudget(pool),j.budgetId,tool,{query:'again'},true));assert.equal(calls,1);assert.equal((await j.store.snapshot(j.budgetId)).reserved,2);
});
test('provider nested failures never become evidence and reported charge mismatch blocks job',async()=>{
 const j=await job();const api=new Alexandria({apiKey:'mock',fetch:async()=>response('tiktok/search-videos',payload,3)});
 await assert.rejects(api.execute(j.store,j.budgetId,tool,{query:'cost changed'},true),/exceeded/);assert.equal((await j.store.snapshot(j.budgetId)).blocked_reason,'cost_mismatch');
 const k=await job();await assert.rejects(new Alexandria({apiKey:'mock',fetch:async()=>response('tiktok/search-videos',{success:false},0)}).execute(k.store,k.budgetId,tool,{query:'nested error'},true));
});
test('model identifier is checked with actual account access and no generation call',async()=>{
 const good=await verifyResearchModel('verified-test',async(url)=>{assert.ok(String(url).endsWith('/v1/models/verified-test'));return Response.json({id:'verified-test'});});assert.equal(good.id,'verified-test');
 await assert.rejects(verifyResearchModel('missing',async()=>Response.json({},{status:404})));await assert.rejects(verifyResearchModel(''));
});
test('provider fields preserve unknown metrics, exact timestamps and stable URL deduplication',()=>{
 assert.equal(evidence.length,2);assert.equal(evidence[0].views,1000000);assert.ok(recentEvidence(evidence[0]));
 const ig=normaliseSocial('instagram/search-reels',{reels:[{url:'https://www.instagram.com/reel/Abc/?utm_source=x',caption:'แรงตึงผิวกับน้ำ',taken_at:observed,like_count:0},{url:'https://www.instagram.com/p/Abc/',caption:'แรงตึงผิวกับน้ำ',taken_at:observed,like_count:0}]},observed);
 assert.equal(ig.length,1);assert.equal(ig[0].views,null);assert.equal(ig[0].likes,0);assert.equal(ig[0].comments,null);
 for(const e of [{...evidence[0],publishedAt:null},{...evidence[0],publishedAt:new Date(Date.now()-8*86400000).toISOString()},{...evidence[0],publishedAt:new Date(Date.now()+86400000).toISOString()}])assert.equal(recentEvidence(e),false);
});
test('one post, one creator, fake quotes or forged supporting IDs cannot establish a trend',()=>{
 assert.equal(assessPattern(assessment,evidence).verified,true);
 assert.equal(assessPattern(assessment,evidence.slice(0,1)).verified,false);
 assert.equal(assessPattern(assessment,evidence.map(e=>({...e,author:'same'}))).verified,false);
 assert.equal(assessPattern({...assessment,quotes:assessment.quotes.map(q=>({...q,quote:'fabricated quote'}))},evidence).verified,false);
 assert.equal(assessPattern({...assessment,source_ids:[...assessment.source_ids,'invented']},evidence).verified,false);
});
test('missing metrics reduce confidence; growth needs older observations of the same source',()=>{
 const score=assessPattern(assessment,evidence);assert.equal(score.components.growth_velocity,null);assert.equal(score.growth.length,0);
 const missing=assessPattern(assessment,evidence.map(e=>({...e,views:null,likes:null,comments:null})));assert.ok(missing.confidence<score.confidence);assert.equal(missing.components.engagement,null);
 const before=evidence.map(e=>({...e,observedAt:new Date(Date.now()-8*3600000).toISOString(),views:500000}));assert.equal(assessPattern(assessment,evidence,before).growth[0].views_delta,500000);
});
test('web evidence only takes URLs returned by tool sources or citations',()=>{
 assert.deepEqual(webEvidence({output:[{type:'message',content:[{type:'output_text',text:'https://fabricated.example'}]}]}),[]);
 assert.equal(webEvidence({output:[{type:'web_search_call',action:{sources:[{url:'https://official.example',title:'Source'}]}}]}).length,1);
});
test('web-derived topic ideas require saved web research and never masquerade as social trends',()=>{
 const ideas=['ทำไมท้องฟ้าเปลี่ยนสีในตอนเย็น','แสงเดินทางผ่านอากาศอย่างไร','ลองมองสีของท้องฟ้าผ่านหยดน้ำ'].map(title=>({title,explanation:'คำถามจากข้อมูลเว็บ',interesting:'เห็นได้ในชีวิตประจำวัน',kind:'web',trend_ids:[]}));
 const r={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({ideas})}]}]};
 assert.equal(parseDetailedIdeas(r,[],3,'web',[],true).length,3);
 assert.throws(()=>parseDetailedIdeas(r,[],3,'web',[],false));assert.throws(()=>parseDetailedIdeas(r,[],3,'trending',[],true));
});
test('research route authentication, request replay and conflicting payload do not create duplicate jobs',async()=>{
 process.env.MOTION_TREND_RESEARCH_ENABLED='1';process.env.TREND_RESEARCH_MODEL='verified-model';const app=new Hono();registerTrendRoutes(app,pool,async(c,next)=>c.req.header('authorization')==='owner'?next():c.json({},401));
 const request_id=randomUUID(),headers={authorization:'owner','content-type':'application/json'};const body={request_id,platform:'both',query:'แรงตึงผิวกับน้ำ'};
 assert.equal((await app.request('/app/api/studio/trends/refresh',{method:'POST',body:JSON.stringify(body)})).status,401);
 const a=await app.request('/app/api/studio/trends/refresh',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(a.status,202);const first:any=await a.json();
 const b=await app.request('/app/api/studio/trends/refresh',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(b.status,200);assert.equal((await b.json() as any).id,first.id);
 const alias=randomUUID();const aliased=await app.request('/app/api/studio/trends/refresh',{method:'POST',headers,body:JSON.stringify({...body,request_id:alias})});assert.equal((await aliased.json() as any).id,first.id);
 const found=await app.request('/app/api/studio/trends/runs/'+alias,{headers});assert.equal(found.status,200);assert.equal((await found.json() as any).id,first.id);
 assert.equal((await app.request('/app/api/studio/trends/refresh',{method:'POST',headers,body:JSON.stringify({...body,query:'เปลี่ยนหัวข้อ'})})).status,409);
 const rows:any=(await query('SELECT count(*)::int AS n FROM trend_alexandria_jobs WHERE request_id=$1',[request_id])).rows[0];assert.equal(rows.n,1);
 assert.equal((await app.request('/app/api/studio/trends')).status,401);
});
test('complete mocked research → Notion → topic → script selection uses corroborated sources and same checkpoints',async()=>{
 process.env.OPENAI_API_KEY='mock';process.env.NOTION_TOKEN='mock';process.env.NOTION_TREND_DATABASE_ID='mock-db';process.env.TREND_RESEARCH_MODEL='gpt-6.1-terra';
 const j=await job();let paid=0,openai=0,notionCreates=0;let planned=false;
 globalThis.fetch=async(url,init)=>{
  const u=String(url),body=init?.body?JSON.parse(String(init.body)):{};
  if(u.includes('/v1/models/'))return Response.json({id:'gpt-6.1-terra'});
  if(u.includes('firecrawl.dev')){const c=body.alexandria.capability;if(c==='find-tools')return response(c,{items:catalog,total:catalog.length},0);assert.ok(planned,'Web Search precedes paid calls');paid++;return response(c,payload);}
  if(u.includes('api.notion.com')){if(u.endsWith('/query'))return Response.json({results:[]});if(u.endsWith('/pages')){notionCreates++;return Response.json({id:'notion-page'});}return Response.json({id:'notion-page'});}
  if(u.endsWith('/v1/responses')){openai++;const plan=body.text.format.name==='research_plan';if(plan)planned=true;return Response.json({id:'resp_mock_'+openai,status:'completed',usage:{input_tokens:300,output_tokens:100},output:[...(plan?[{type:'web_search_call',status:'completed',action:{sources:[{url:'https://science.example/surface',title:'Primary article'}]}}]:[]),{type:'message',content:[{type:'output_text',text:JSON.stringify(plan?{summary:'ข้อมูลจากเว็บ ยังไม่ใช่เทรนด์โซเชียล',queries:[{platform:'tiktok',thai:'แรงตึงผิวไทย',english:'surface tension Thai',capability:'tiktok/search-videos',reason:'ต้องตรวจตัวเลขจริง'}]}:{patterns:[assessment]})}]}]});}
  throw new Error('Unexpected mock URL '+u);
 };
 const run={id:j.id,budget_id:j.budgetId,checkpoint:{},request:{platform:'tiktok',model:'gpt-6.1-terra',count:10,query:'แรงตึงผิว',audience:'เด็กไทย'}};
 const result=await runResearch(pool,pool,run);assert.equal(result.status,'done');assert.equal(result.eligible_count,1);assert.equal(paid,2);assert.equal(openai,2);assert.equal(notionCreates,1);
 const rows=await eligibleTrends(pool);assert.equal(rows.length,1);assert.equal(rows[0].provider_name,'scrapecreators');assert.equal(rows[0].actual_credits,4);assert.equal(rows[0].supporting_sources.length,2);
 const props=notionProperties(rows[0]);assert.equal(props['Confidence']!.number,80);assert.equal(props['Actual Credits']!.number,4);
 const id=randomUUID();const ideas=['ทำไมพริกไทยหนีสบู่','แรงตึงผิวทำอะไรได้บ้าง','หยดน้ำเดินทางอย่างไร'].map(title=>({title,explanation:'จากการทดลอง',interesting:'ชวนสังเกต',kind:'trending',trend_ids:[rows[0].id]}));
 const parsed=parseDetailedIdeas({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({ideas})}]}]},[],3,'trending',rows);assert.equal(parsed.length,3);
 await query("INSERT INTO topic_suggestions(id,request_hash,request,status,idea_details) VALUES($1,'hash','{}','done',$2)",[id,JSON.stringify(parsed)]);
 const ctx=await selectedContext(pool,{id,index:0},parsed[0].title);assert.ok(ctx);assert.equal(ctx.warning,null);assert.equal(ctx.sources[0].supporting_sources.length,2);assert.equal(ctx.sources[0].research_job_id,j.budgetId);
 const checkpoint:any=(await query('SELECT checkpoint FROM trend_alexandria_jobs WHERE run_id=$1',[j.id])).rows[0];await runResearch(pool,pool,{...run,checkpoint:checkpoint.checkpoint});assert.equal(paid,2);assert.equal(openai,2);assert.equal(notionCreates,1);
 globalThis.fetch=nativeFetch;
});
test('production UI script parses and keeps unrelated creation surfaces with new research controls',()=>{
 const ui=readFileSync(new URL('./ui.html',import.meta.url),'utf8');for(const [,code] of ui.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(code);
 for(const marker of ['Discover Trends','Last 7 Days','ผลค้นหาเทรนด์','Text to Video','Lemo','ms.trend_research_pending'])assert.ok(ui.includes(marker),marker);
});
