// Quote-time lookups can fail before a job exists. Keep account responses private.
export async function checkQuoteCredit(response:Response,provider:string){
  if(response.ok)return;
  let billing=response.status===402;
  if(!billing&&[400,403,429].includes(response.status)){
    const body:any=await response.json().catch(()=>null);
    const detail=body?.error||body?.detail||body;
    const code=String(detail?.code||detail?.type||'').toLowerCase();
    const message=typeof detail==='string'?detail:String(detail?.message||detail?.reason||'');
    billing=['insufficient_quota','insufficient_credits','insufficient_balance','billing_hard_limit_reached','exhausted_balance'].includes(code)||
      /exhausted balance|insufficient balance|insufficient credit|out of credits|billing hard limit|exceeded your current quota/i.test(message);
  }
  if(billing)throw Error(provider+' แจ้งว่าเครดิตหรือโควตาการใช้งานไม่พอ เติมเครดิตหรือปรับวงเงินแล้วเปิดราคาอีกครั้ง');
}
