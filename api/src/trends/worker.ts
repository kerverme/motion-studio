import pg from 'pg';
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {Alexandria,verifyResearchModel} from './alexandria.js';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const log=(event:string,data:any={})=>console.log(JSON.stringify({event,at:new Date().toISOString(),...data}));
let ready=false;let health:any={adapter:'firecrawl-alexandria',stage:'catalogue_validation'};
createServer((req,res)=>{res.writeHead(req.url==='/health'?(ready?200:503):404,{'Content-Type':'application/json'}).end(JSON.stringify({ok:ready,...health}));}).listen(Number(process.env.PORT)||8080,'0.0.0.0');
async function start(){
 const db=await pool.connect();
 try{await db.query('SELECT pg_advisory_lock(424242)');
  const done=new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r=>r.name));
  for(const file of (await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())if(!done.has(file)){
   await db.query('BEGIN');await db.query(await readFile(new URL('../../migrations/'+file,import.meta.url),'utf8'));await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);await db.query('COMMIT');log('migration_applied',{file});
  }
 }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.query('SELECT pg_advisory_unlock(424242)');db.release();}
 const adapter=new Alexandria({apiKey:process.env.FIRECRAWL_API_KEY||''});
 const model=await verifyResearchModel(process.env.TREND_RESEARCH_MODEL||'');health.model=model;
 log('research_model_verified',model);
 for(const provider of ['scrapecreators','oriane']){
  try{const tools=await adapter.discover(provider);await pool.query('INSERT INTO trend_alexandria_catalog(provider,tools) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET tools=EXCLUDED.tools,checked_at=now(),error=NULL',[provider,JSON.stringify(tools)]);
   log('catalogue_verified',{provider,tools:tools.map(t=>({capability:t.capability,creditsCost:t.creditsCost,perRecord:t.perRecord,billing:t.billing})),discovery_credits:0});
  }catch(e){const error=e instanceof Error?e.message:'Catalogue failed';await pool.query('INSERT INTO trend_alexandria_catalog(provider,error) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET checked_at=now(),error=EXCLUDED.error',[provider,error]);log('catalogue_unavailable',{provider,error});health.catalogue_error=error;}
 }
 ready=true;log('research_worker_ready',health);
}
start().catch(e=>{log('startup_failed',{error:e instanceof Error?e.message:'startup failed'});process.exit(1);});
