import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {canonicalSource,metric,scoreEvidence,isEligible,type Evidence} from './trends/policy.js';
import {saveEvidence,eligibleTrends,selectedContext,trendPrompt} from './trends/store.js';
import {notionProperties,syncNotion} from './trends/notion.js';
import {researchResponse,reconcileUsage} from './trends/provider.js';
import {parseDetailedIdeas} from './topic-suggestions.js';
const now=Date.now(),date=(days:number)=>new Date(now-days*86400000).toISOString();
const evidence:Evidence={platform:'tiktok',sourceId:'123456789',url:'https://www.tiktok.com/@science/video/123456789',title:'ทำไมท้องฟ้าถึงเปลี่ยนสี',publishedAt:date(1),observedAt:date(0),views:1000000,likes:5000,comments:null,detailRead:true,available:true,publicationEvidence:date(1)};
const assessment={suitability:90,reason:'อธิบายด้วยภาพได้',summary:'ตั้งคำถามจากโพสต์ที่อ่าน',angles:['สีจากแสง','ตัวอย่างในชีวิตประจำวัน']};
const db=new PGlite(),pool:any={query:(sql:string,args:any[]=[])=>db.query(sql,args)};
before(async()=>{await db.exec('CREATE TABLE drafts(id uuid PRIMARY KEY);');for(const f of ['018_topic_suggestions.sql','030_trend_research.sql'])await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));});
after(()=>db.close());
test('canonical stable identities reject lookalike domains, credentials and arbitrary URLs',()=>{
 assert.equal(canonicalSource('https://instagram.com/reel/Abc_123/?utm_source=x')?.url,'https://www.instagram.com/p/Abc_123/');
 for(const u of ['http://www.tiktok.com/@a/video/1','https://www.tiktok.com.evil.test/@a/video/1','https://secret@instagram.com/p/Abc/','https://instagram.com:8443/p/Abc/','https://127.0.0.1/p/Abc/'])assert.equal(canonicalSource(u),null);
 assert.equal(metric(null),null);assert.equal(metric('1.2M'),null);assert.equal(metric(-1),null);assert.equal(metric('0'),0);
});
test('recent reads never refresh old publication; actual two-snapshot growth can qualify',()=>{
 const recent=scoreEvidence(evidence,[],{now,suitability:90});assert.equal(recent.status,'Active');assert.equal(recent.viewGrowth,null);assert.equal(recent.engagementRate,null);assert.equal(recent.evidenceAt,evidence.publishedAt);
 const old={...evidence,publishedAt:date(30),publicationEvidence:date(30)};
 assert.equal(scoreEvidence(old,[],{now,suitability:100}).status,'Expired');
 assert.equal(scoreEvidence(old,[{...old,observedAt:date(1)}],{now,suitability:100}).status,'Expired');
 const growth=scoreEvidence({...old,views:1200000},[{...old,observedAt:date(1)}],{now,suitability:90});assert.equal(growth.status,'Active');assert.equal(growth.viewGrowth,200000);assert.equal(growth.evidenceAt,evidence.observedAt);
 assert.equal(scoreEvidence({...evidence,publishedAt:null,publicationEvidence:null},[],{now,suitability:100}).status,'Unverified');
 assert.equal(scoreEvidence({...evidence,detailRead:false},[],{now,suitability:100}).status,'Unverified');
 assert.equal(scoreEvidence({...evidence,views:null,likes:null},[],{now,suitability:100}).status,'Unverified');
 assert.equal(scoreEvidence({...evidence,available:false},[],{now,suitability:100}).status,'Failed');
 assert.throws(()=>scoreEvidence(evidence,[],{weights:{popularity:1,freshness:1,suitability:1,novelty:1}}));
});
test('SQL upsert deduplicates stable post IDs and preserves discovery date, snapshots and null metrics',async()=>{
 const run1=randomUUID(),run2=randomUUID();for(const id of [run1,run2])await db.query('INSERT INTO trend_research_runs(id,request_key,request) VALUES($1::uuid,$1::text,$2)',[id,'{}']);
 const first=await saveEvidence(pool,run1,evidence,assessment);
 const second=await saveEvidence(pool,run2,{...evidence,url:evidence.url+'?tracking=removed',views:1000200},assessment);
 assert.equal(first.id,second.id);assert.equal(+new Date(first.discovered_at),+new Date(second.discovered_at));assert.notEqual(+new Date(second.published_at),+new Date(second.discovered_at));
 assert.equal((await db.query('SELECT * FROM trend_evidence_snapshots')).rows.length,2);
 assert.equal(second.comments,null);assert.equal(second.engagement_rate,null);assert.equal(notionProperties(second).Comments.number,null);
 assert.equal((await eligibleTrends(pool)).length,0,'Notion must be synchronized before a trend can feed generation');
});
test('ambiguous Notion create is reconciled by stable Source ID without a duplicate create',async()=>{
 process.env.NOTION_TOKEN='test-secret';process.env.NOTION_TREND_DATABASE_ID=randomUUID();
 let creates=0,created=false;const page=randomUUID();
 const request:any=async(url:string,init:any)=>{if(url.endsWith('/query'))return Response.json({results:created?[{id:page}]:[]});if(url.endsWith('/pages')){creates++;created=true;throw new Error('response lost');}return Response.json({id:page});};
 let row:any=(await db.query('SELECT * FROM trend_sources')).rows[0];await assert.rejects(syncNotion(pool,row,request));
 row=(await db.query('SELECT * FROM trend_sources')).rows[0];assert.equal(row.notion_sync_error,'create_uncertain');
 await syncNotion(pool,row,request);row=(await db.query('SELECT * FROM trend_sources')).rows[0];assert.equal(creates,1);assert.equal(row.notion_page_id,page);assert.equal(isEligible(row),true);
 await syncNotion(pool,row,request);assert.equal(creates,1);assert.equal((await eligibleTrends(pool)).length,1);
});
test('topic parser rejects fabricated IDs, ungrounded trending labels and stale selection warns',async()=>{
 const source:any=(await db.query('SELECT * FROM trend_sources')).rows[0];
 const ideas=Array.from({length:3},(_,i)=>({title:'ทำไมสีท้องฟ้าตอนเย็นจึงต่างกัน '+i,explanation:'เล่าด้วยแสง',interesting:'เรื่องใกล้ตัว',kind:'trending',trend_ids:[source.id]}));
 const response=(ideas:any)=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({ideas})}]}]});
 assert.equal(parseDetailedIdeas(response(ideas),[],3,'trending',[source]).length,3);
 assert.throws(()=>parseDetailedIdeas(response(ideas),[],3,'trending',[]));
 assert.throws(()=>parseDetailedIdeas(response(ideas.map(x=>({...x,kind:'creative'}))),[],3,'creative',[source]));
 const id=randomUUID();await db.query("INSERT INTO topic_suggestions(id,request_hash,request,status,ideas,idea_details) VALUES($1,'hash','{}','done',$2,$3)",[id,JSON.stringify(ideas.map(x=>x.title)),JSON.stringify(ideas)]);
 const selected=await selectedContext(pool,{id,index:0},ideas[0].title);assert.deepEqual(selected!.trend_ids,[source.id]);assert.equal(selected!.warning,null);
 await assert.rejects(selectedContext(pool,{id,index:0},'หัวข้อคนละเรื่อง'));
 await db.query("UPDATE trend_sources SET last_trend_evidence_at=now()-interval '8 days' WHERE id=$1",[source.id]);
 assert.ok((await selectedContext(pool,{id,index:0},ideas[0].title))!.warning);
 assert.equal((await eligibleTrends(pool)).length,0);
 assert.match(trendPrompt(selected),/Never count this saved context as a fetched page/);
});
test('an ambiguous paid provider call is not posted twice',async()=>{
 const run=randomUUID();await db.query('INSERT INTO trend_research_runs(id,request_key,request) VALUES($1::uuid,$1::text,$2)',[run,'{}']);
 await db.query('INSERT INTO trend_provider_calls(research_run_id,call_key,model) VALUES($1,$2,$3)',[run,run+':decision-1','gpt-6.1-terra']);
 await assert.rejects(researchResponse(pool,run,'decision-1',{},Date.now()+30000),/refusing duplicate/);
});
test('cancelled provider usage is reconciled once by GET without creating another paid request',async()=>{
 const run=randomUUID();await db.query('INSERT INTO trend_research_runs(id,request_key,request) VALUES($1::uuid,$1::text,$2)',[run,'{}']);
 await db.query("INSERT INTO trend_provider_calls(research_run_id,call_key,model,status,response_id) VALUES($1,$2,'gpt-6.1-terra','failed','resp_cancelled')",[run,run+':cancelled']);
 let reads=0;const request:any=async(url:string,init:any)=>{reads++;assert.equal(init.method,undefined);assert.ok(url.endsWith('/resp_cancelled'));return Response.json({id:'resp_cancelled',status:'cancelled',usage:{input_tokens:100,output_tokens:20},output:[]});};
 const result=await reconcileUsage(pool,request);assert.equal(result.length,1);assert.equal(result[0].status,'cancelled');assert.equal(result[0].estimated_usd,.0002);
 await reconcileUsage(pool,request);assert.equal(reads,1);
 const row:any=(await db.query('SELECT * FROM trend_provider_calls WHERE call_key=$1',[run+':cancelled'])).rows[0];assert.equal(row.actual_usd,null);assert.equal(row.status,'failed');
});
test('a topic finished by an older API deployment still reconciles its pending provider ledger',async()=>{
 const id=randomUUID();
 await db.query("INSERT INTO topic_suggestions(id,request_hash,request,status,response_id) VALUES($1,'prior-release','{}','failed','resp_legacycancel')",[id]);
 await db.query("INSERT INTO trend_provider_calls(topic_suggestion_id,call_key,model) VALUES($1,$2,'gpt-6.1-terra')",[id,'topic:'+id]);
 let reads=0;const request:any=async(url:string,init:any)=>{reads++;assert.equal(init.method,undefined);assert.ok(url.endsWith('/resp_legacycancel'));return Response.json({id:'resp_legacycancel',status:'cancelled',usage:{input_tokens:0,output_tokens:0},output:[]});};
 const result=await reconcileUsage(pool,request);assert.equal(result.length,1);assert.equal(result[0].estimated_usd,0);
 await reconcileUsage(pool,request);assert.equal(reads,1);
 const row:any=(await db.query('SELECT * FROM trend_provider_calls WHERE topic_suggestion_id=$1',[id])).rows[0];assert.equal(row.status,'failed');assert.ok(row.finished_at);assert.equal(row.actual_usd,null);
});
