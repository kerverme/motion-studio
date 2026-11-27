import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Context, Hono, Next } from 'hono';
import { z } from 'zod';
import { BudgetedFirecrawl, PgResearchBudget } from './firecrawl-budget.js';
import { openaiResponse, OpenAIReadUnavailable } from './openai-response.js';
import { discoverShopee, ideaCards, ideaInstructions } from './ugc-shopee.js';
import { uuid } from './ugc-contract.js';

const path='/app/api/ugc/ideas';
export function registerUgcIdeas(app:Hono,pool:pg.Pool,options:{
  guard:(c:Context,next:Next)=>Promise<any>;env:NodeJS.ProcessEnv;respond:typeof openaiResponse;
  models:()=>Promise<{models:{id:string}[]}>;fetch?:typeof fetch;
}){
  const {guard,env}=options;
  let busy=false;
  async function advance(){
    if(busy)return;
    busy=true;
    try{
      const lease=randomUUID();
      const row=(await pool.query(`UPDATE ugc_idea_searches SET lease_id=$1,next_at=now()+interval '10 minutes'
        WHERE id=(SELECT id FROM ugc_idea_searches WHERE state NOT IN ('done','failed') AND next_at<=now()
        ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,[lease])).rows[0];
      if(!row)return;
      const update=(columns:string,params:unknown[]=[])=>pool.query('UPDATE ugc_idea_searches SET '+columns+' WHERE id=$1 AND lease_id=$2',[row.id,lease,...params]);
      if(row.state==='submitting'&&!row.response_id){
        await update("state='failed',notice='ยังไม่ทราบผลการส่งให้ OpenAI ครั้งก่อน ระบบหยุดเพื่อป้องกันคำขอซ้ำ'");
        return;
      }
      try{
        if(row.state==='research'){
          const client=new BudgetedFirecrawl(new PgResearchBudget(pool,25),{
            apiKey:env.FIRECRAWL_API_KEY!,baseUrl:(env.FIRECRAWL_API_URL||'https://api.firecrawl.dev').replace(/\/$/,''),fetch:options.fetch});
          const {evidence,notice}=await discoverShopee(client,row.id,row.query);
          await update('state=$3,evidence=$4,notice=$5,next_at=now()',[evidence.length?'summarize':'done',JSON.stringify(evidence),notice]);
          return;
        }
        if(!row.response_id)await update("state='submitting'");
        const result=await options.respond({model:row.model,reasoning:{effort:'low'},text:{format:{type:'json_object'}},
          max_output_tokens:3000,instructions:ideaInstructions,input:JSON.stringify({query:row.query,listings:row.evidence})},{
          apiKey:env.OPENAI_API_KEY!,baseUrl:env.OPENAI_BASE_URL||'https://api.openai.com',pollOnce:true,keepAccepted:true,
          responseId:row.response_id??undefined,timeoutMs:50000,onAccepted:async id=>{row.response_id=id;await update("state='accepted',response_id=$3",[id]);}});
        if(['queued','in_progress'].includes(result.status)){
          await update("state='accepted',response_id=$3,next_at=now()+interval '4 seconds'",[result.id]);return;
        }
        if(result.status!=='completed')throw Error();
        const prose=(result.output??[]).flatMap((o:any)=>o.content??[]).filter((o:any)=>o.type==='output_text').map((o:any)=>o.text).join('');
        const cards=ideaCards(row.evidence,prose);
        await update("state='done',cards=$3,notice=$4",[JSON.stringify(cards),row.notice??(cards.length?null:'ไม่มีสินค้าที่ตอบคำค้นจากหลักฐานชุดนี้')]);
      }catch(error){
        if(row.response_id && error instanceof OpenAIReadUnavailable)await update("state='accepted',next_at=now()+interval '20 seconds'");
        else await update("state='failed',notice=$3",[row.state==='research'?'อ่านหลักฐานจาก Shopee ไม่สำเร็จ':'สรุปไอเดียด้วย OpenAI ไม่สำเร็จ']);
      }
    }finally{busy=false;}
  }
  const wake=()=>{void advance().catch(()=>{});};
  async function view(id:string){
    const row=(await pool.query('SELECT id,query,model,state,cards,notice FROM ugc_idea_searches WHERE id=$1',[id])).rows[0];
    if(!row)return null;
    let source=id;
    if(['done','failed'].includes(row.state)&&!row.cards.length){
      const old=(await pool.query("SELECT id,cards FROM ugc_idea_searches WHERE id<>$1 AND query=$2 AND model=$3 AND state='done' AND jsonb_array_length(cards)>0 ORDER BY created_at DESC LIMIT 1",[id,row.query,row.model])).rows[0];
      if(old){row.cards=old.cards;source=old.id;}
    }
    const usage=await new PgResearchBudget(pool,25).snapshot(id);
    return {...row,source_id:source,previous:source!==id,credits_reserved:usage.committed,credits_reported:usage.reported};
  }
  app.post(path,guard,async c=>{
    const key=uuid.safeParse(c.req.header('idempotency-key'));
    const input=z.object({query:z.string().trim().min(2).max(200),model:z.string().min(1).max(100)}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!key.success||!input.success)return c.json({error:'กรอกคำค้นและเลือกโมเดลคิดไอเดีย'},422);
    const previous=await view(key.data);
    if(previous){
      if(previous.query!==input.data.query||previous.model!==input.data.model)return c.json({error:'คำขอเดิมใช้คำค้นหรือโมเดลต่างกัน'},409);
      wake();return c.json(previous);
    }
    if(!env.FIRECRAWL_API_KEY||!env.OPENAI_API_KEY)return c.json({error:'ยังไม่ได้ตั้งค่า Firecrawl หรือ OpenAI สำหรับคิดไอเดีย'},503);
    if(!(await options.models()).models.some(m=>m.id===input.data.model))return c.json({error:'โมเดลคิดไอเดียที่เลือกไม่อยู่ในรายการล่าสุด'},409);
    await pool.query('INSERT INTO ugc_idea_searches(id,query,model) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[key.data,input.data.query,input.data.model]);
    const created=await view(key.data);
    if(created.query!==input.data.query||created.model!==input.data.model)return c.json({error:'คำขอเดิมใช้คำค้นหรือโมเดลต่างกัน'},409);
    wake();return c.json(created,202);
  });
  app.get(path+'/:id',guard,async c=>{
    c.header('Cache-Control','no-store');
    const id=uuid.safeParse(c.req.param('id'));
    const result=id.success&&await view(id.data);
    if(!result)return c.json({error:'ไม่พบงานค้นหา'},404);
    if(!['done','failed'].includes(result.state))wake();
    return c.json(result);
  });
  return {wake};
}
