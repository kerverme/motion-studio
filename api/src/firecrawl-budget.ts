import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { sourceKey } from './source-evidence.js';

export const RESEARCH_CREDIT_LIMIT = 25;
export class ResearchBudgetError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export type Budget = { research_job_id: string; limit: number; committed: number; remaining: number; reserved: number; reported: number; calls: number; blocked_reason: string | null };
export type SafeRequest = { path: string; body: Record<string, unknown>; maximum: number; urls: string[]; key: string };
const reject = (message: string): never => { throw new ResearchBudgetError('uncertain_cost', message); };

/** Closed allowlist: callers cannot pass arbitrary options or unpriced endpoints. */
export function priceRequest(path: string, input: Record<string, any>): SafeRequest {
  let body: Record<string, unknown>, maximum: number, urls: string[] = [];
  if (path === '/v2/scrape') {
    if (Object.keys(input).some(k => k !== 'url')) reject('Only plain single-page markdown extraction has an approved maximum cost.');
    const key = sourceKey(String(input.url || ''));
    if (!key) reject('A public HTTP(S) source URL is required.');
    const url = new URL(key), hostname = url.hostname.toLowerCase();
    if (isIP(hostname.replace(/^\[|\]$/g,'')) || !hostname.includes('.') || hostname.endsWith('.local') || hostname.endsWith('.internal') || url.port && !['80','443'].includes(url.port)) reject('Only public source domains are allowed.');
    if (['x.com','twitter.com','t.co','linkedin.com','lnkd.in'].some(h => hostname === h || hostname.endsWith('.'+h))) reject('X/Twitter and provider-routed extraction have no approved maximum charge.');
    if (/\.pdf(?:$|[/?&#])/i.test(decodeURIComponent(key))) reject('PDF parsing is disabled until its maximum cost is explicitly known.');
    // Explicitly disable all document parsers, including extensionless/redirected PDFs.
    // Reserve base 1 + up to 2 for an account-level threat scan. No LLM extraction,
    // actions, agent, media, ZDR, or proxy escalation. Pricing: docs.firecrawl.dev/billing.
    body = {url: key, formats:['markdown'], onlyMainContent:true, parsers:[], proxy:'basic', zeroDataRetention:false, timeout:60000};
    maximum = 3; urls = [key];
  } else if (path === '/v2/search') {
    if (Object.keys(input).some(k => !['query','recent'].includes(k))) reject('Search scraping, enrichments and unpriced options are disabled.');
    const query = String(input.query || '').trim().slice(0,300);
    if (!query) reject('A search query is required.');
    body = {query, limit:5, sources:['web'], ...(input.recent ? {tbs:'qdr:y'} : {})};
    // No scrapeOptions: never scrape arbitrary search results (PDF/X included).
    maximum = 2 + 2 * 5; // search + conservative allowance for account threat scans
  } else if (path === '/v2/map') {
    reject('Map is not needed for deeper source extraction; use a selected source URL.');
  } else reject('Endpoint has no approved maximum charge; agent, crawl, batch and extraction are disabled.');
  const key = createHash('sha256').update('bounded-v1:'+path+':'+JSON.stringify(body!)).digest('hex');
  return {path,body:body!,maximum:maximum!,urls,key};
}

export interface BudgetStore {
  exclusive<T>(job: string, fn: () => Promise<T>): Promise<T>;
  snapshot(job: string): Promise<Budget>;
  cached(key: string): Promise<{payload:any; source_urls:string[]; collected_at:string} | null>;
  reserve(job: string, req: SafeRequest): Promise<string>;
  finish(job: string, id: string, req: SafeRequest, payload: any, error?: string, uncertain?: boolean): Promise<void>;
}

/** No retries: an ambiguous transport failure may already have incurred a charge. */
export class BudgetedFirecrawl {
  constructor(private store: BudgetStore, private options: {apiKey:string; baseUrl:string; fetch?:typeof fetch}) {}
  async request(job: string, path: string, input: Record<string, any>, fallback: {webAttempted:boolean; reason:string}) {
    if (!fallback.webAttempted || fallback.reason.trim().length < 12) throw new ResearchBudgetError('web_first', 'Use OpenAI Web Search first; explain which evidence is missing before Firecrawl fallback.');
    const req = priceRequest(path,input);
    return this.store.exclusive(job, async () => {
      const cached = await this.store.cached(req.key);
      if (cached) return {...cached, cache_hit:true, budget:await this.store.snapshot(job)};
      const id = await this.store.reserve(job,req); // durable commit BEFORE fetch
      let response: Response, payload: any;
      try {
        response = await (this.options.fetch || fetch)(this.options.baseUrl + path, {method:'POST', headers:{authorization:`Bearer ${this.options.apiKey}`,'content-type':'application/json'}, body:JSON.stringify(req.body), signal:AbortSignal.timeout(90000)});
        payload = await response.json();
      } catch {
        await this.store.finish(job,id,req,null,'Ambiguous response; reserved maximum retained. No automatic retry.',true);
        throw new ResearchBudgetError('uncertain_charge','Firecrawl response is uncertain. Reservation retained; further Firecrawl calls are stopped for this Research Job.');
      }
      if (!response.ok || payload?.success !== true) {
        await this.store.finish(job,id,req,payload,`Firecrawl HTTP ${response.status}; maximum retained.`);
        const err = new ResearchBudgetError('provider_error',`Firecrawl HTTP ${response.status}; no automatic retry, reserved maximum retained.`);
        if ([402,429].includes(response.status)) Object.assign(err,{fcDown:true});
        throw err;
      }
      // Provider errors/blocked documents cannot become verified source evidence.
      const data = payload.data;
      if (path === '/v2/scrape' && (!data?.markdown?.trim() || data.metadata?.error || Number(data.metadata?.statusCode || 200) >= 400 || data.rawBase64)) {
        await this.store.finish(job,id,req,null,'No usable source text; maximum retained.');
        throw new ResearchBudgetError('no_evidence','Source extraction returned no usable text. Do not cite or fabricate its contents.');
      }
      const urls = [...new Set([...req.urls, ...(path === '/v2/search' ? (data?.web || []).map((x:any)=>x.url) : [data?.metadata?.sourceURL,data?.metadata?.url])].filter((x):x is string => typeof x === 'string' && !!sourceKey(x)))];
      const safePayload = path === '/v2/scrape' ? {...payload,data:{markdown:String(data.markdown).slice(0,100000),metadata:data.metadata}} : payload;
      await this.store.finish(job,id,{...req,urls},safePayload);
      const budget = await this.store.snapshot(job);
      if (budget.blocked_reason) throw new ResearchBudgetError('cost_mismatch','Reported Firecrawl cost exceeded the approved estimate; further calls are blocked.');
      const stored=await this.store.cached(req.key);
      return {payload:safePayload,source_urls:urls,collected_at:stored?.collected_at || new Date().toISOString(),cache_hit:false,budget};
    });
  }
}

/** PostgreSQL session lock spans reservation + HTTP + settlement, across processes. */
export class PgResearchBudget implements BudgetStore {
  private client?: pg.PoolClient;
  private queue: Promise<void> = Promise.resolve();
  constructor(private pool: pg.Pool) {}
  private db() { return this.client || this.pool; }
  async ensure(job:string) { await this.db().query('INSERT INTO research_jobs (id) VALUES ($1) ON CONFLICT DO NOTHING',[job]); }
  async exclusive<T>(_job:string, fn:()=>Promise<T>):Promise<T> {
    // A separate store instance is used per draft. The global lock also serializes
    // different research jobs/replicas. Fail fast instead of exhausting the pool.
    const previous=this.queue;
    let next!:()=>void;
    this.queue=new Promise<void>(resolve=>{next=resolve;});
    await previous;
    let client:pg.PoolClient;
    try { client=await this.pool.connect(); } catch(e) { next(); throw e; }
    let locked = false, destroyed = false;
    try {
      locked = !!(await client.query('SELECT pg_try_advisory_lock(731125) AS locked')).rows[0]?.locked;
      if (!locked) throw new ResearchBudgetError('busy','Another Firecrawl request is in progress; no request was sent.');
      this.client = client;
      return await fn();
    } finally {
      this.client = undefined;
      if (locked) { try { await client.query('SELECT pg_advisory_unlock(731125)'); } catch { client.release(true); destroyed=true; } }
      if (!destroyed) client.release();
      next();
    }
  }
  async snapshot(job:string):Promise<Budget> {
    await this.ensure(job);
    const r = (await this.db().query(`SELECT j.*,
      COALESCE(sum(r.reserved_credits) FILTER (WHERE r.state IN ('reserved','uncertain')),0)::int AS reserved,
      COALESCE(sum(r.reported_credits),0)::int AS reported, count(r.id)::int AS calls
      FROM research_jobs j LEFT JOIN firecrawl_requests r ON r.research_job_id=j.id WHERE j.id=$1 GROUP BY j.id`,[job])).rows[0];
    return {research_job_id:job,limit:r.credit_limit,committed:r.committed_credits,remaining:Math.max(0,r.credit_limit-r.committed_credits),reserved:r.reserved,reported:r.reported,calls:r.calls,blocked_reason:r.blocked_reason};
  }
  async cached(key:string) {
    return (await this.db().query('SELECT payload, source_urls, collected_at FROM firecrawl_cache WHERE cache_key=$1 AND expires_at>now()',[key])).rows[0] || null;
  }
  async reserve(job:string, req:SafeRequest) {
    if (!this.client) throw new Error('A research request must hold the budget lock before reserving credits.');
    const db = this.db(); await this.ensure(job);
    const id = randomUUID();
    await db.query('BEGIN');
    try {
      const pending = await db.query("SELECT id FROM firecrawl_requests WHERE research_job_id=$1 AND state IN ('reserved','uncertain') LIMIT 1",[job]);
      if (pending.rows.length) throw new ResearchBudgetError('uncertain_charge','A previous request has an unresolved charge. Further Firecrawl calls are stopped.');
      const failed=await db.query("SELECT id FROM firecrawl_requests WHERE research_job_id=$1 AND cache_key=$2 AND state='failed' LIMIT 1",[job,req.key]);
      if (failed.rows.length) throw new ResearchBudgetError('no_evidence','This URL already failed extraction in this Research Job. Do not retry or fabricate its contents.');
      const r = await db.query(`UPDATE research_jobs SET committed_credits=committed_credits+$2 WHERE id=$1 AND blocked_reason IS NULL AND committed_credits+$2<=credit_limit RETURNING id`,[job,req.maximum]);
      if (!r.rows.length) throw new ResearchBudgetError('budget_exceeded',`Firecrawl request needs up to ${req.maximum} credits and cannot fit this Research Job. Stop; explicit owner approval is required to increase its budget.`);
      await db.query("INSERT INTO firecrawl_requests (id,research_job_id,endpoint,cache_key,source_urls,reserved_credits,state) VALUES ($1,$2,$3,$4,$5,$6,'reserved')",[id,job,req.path,req.key,JSON.stringify(req.urls),req.maximum]);
      await db.query('COMMIT');
      return id;
    } catch(e) { await db.query('ROLLBACK'); throw e; }
  }
  async finish(job:string,id:string,req:SafeRequest,payload:any,error?:string,uncertain=false) {
    if (!this.client) throw new Error('A research request must hold the budget lock before recording usage.');
    const reported = Number.isSafeInteger(payload?.creditsUsed) && payload.creditsUsed>=0 ? payload.creditsUsed : null;
    const db=this.db();
    await db.query('BEGIN');
    try {
      await db.query('UPDATE firecrawl_requests SET state=$2,reported_credits=$3,error=$4,source_urls=$5,completed_at=now() WHERE id=$1',[id,uncertain?'uncertain':error?'failed':'completed',reported,error || null,JSON.stringify(req.urls)]);
      // Never release reservations based on an incomplete/unattributable usage report.
      if (uncertain || reported !== null && reported>req.maximum) await db.query('UPDATE research_jobs SET blocked_reason=$2 WHERE id=$1',[job,uncertain?'uncertain_charge':'cost_mismatch']);
      if (payload && !error && !(reported !== null && reported>req.maximum)) await db.query(`INSERT INTO firecrawl_cache(cache_key,payload,source_urls,expires_at) VALUES ($1,$2,$3,now()+interval '24 hours') ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,source_urls=excluded.source_urls,collected_at=now(),expires_at=excluded.expires_at`,[req.key,JSON.stringify(payload),JSON.stringify(req.urls)]);
      await db.query('COMMIT');
    } catch(e) { await db.query('ROLLBACK'); throw e; }
  }
  async webRead(job:string,key:string) { await this.ensure(job); return (await this.db().query("SELECT result FROM research_web_reads WHERE research_job_id=$1 AND source_key=$2 AND collected_at>now()-interval '24 hours'",[job,key])).rows[0]?.result || null; }
  async saveWebRead(job:string,key:string,result:unknown) { await this.ensure(job); await this.db().query('INSERT INTO research_web_reads(research_job_id,source_key,result) VALUES ($1,$2,$3) ON CONFLICT(research_job_id,source_key) DO UPDATE SET result=excluded.result,collected_at=now()',[job,key,JSON.stringify(result)]); }
  async approve(job:string,limit:number) {
    if (!Number.isSafeInteger(limit) || limit<=25 || limit>1000) throw new Error('Explicit new total must be an integer from 26 to 1000.');
    return this.exclusive(job,async()=>{
      await this.ensure(job); const db=this.db(); await db.query('BEGIN');
      try {
        const row=(await db.query('SELECT * FROM research_jobs WHERE id=$1 FOR UPDATE',[job])).rows[0];
        if (limit<=row.credit_limit) throw new Error('New total must exceed the current approved limit.');
        await db.query("INSERT INTO research_budget_approvals(research_job_id,previous_limit,new_limit,approved_by) VALUES ($1,$2,$3,'authenticated_owner')",[job,row.credit_limit,limit]);
        await db.query('UPDATE research_jobs SET credit_limit=$2,approved_at=now() WHERE id=$1',[job,limit]);
        await db.query('COMMIT'); return this.snapshot(job);
      } catch(e) { await db.query('ROLLBACK'); throw e; }
    });
  }
}
