const feed='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
type Rate={rate:number|null;source:string|null;date:string|null};
export function ecbUsdToThb(xml:string,now=Date.now()):Rate {
  const tags=[...xml.matchAll(/<Cube\b([^<>]*)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/(\w+)\s*=\s*["']([^"']+)["']/g)].map(a=>[a[1],a[2]])));
  const dates=tags.filter(t=>t.time),date=dates[0]?.time;
  if(dates.length!==1||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid ECB reference date');
  const age=now-Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(age) || age< -86400000 || age>7*86400000) throw new Error('ECB reference rate is stale');
  const fx=(code:string)=>{
    const values=tags.filter(t=>t.currency===code);
    if(values.length!==1 || !/^\d+(\.\d+)?$/.test(values[0].rate) || Number(values[0].rate)<=0)throw new Error('Missing ECB reference rate');
    return Number(values[0].rate);
  };
  const rate=Number((fx('THB')/fx('USD')).toFixed(6));
  if(!Number.isFinite(rate)||rate<=0)throw new Error('Invalid exchange rate');
  return {rate,date,source:feed};
}
let cached:{expires:number;value:Promise<Rate>}|undefined;
export async function getVideoFx():Promise<Rate> {
  const configured=Number(process.env.MOTION_USD_TO_THB);
  if(Number.isFinite(configured)&&configured>0&&configured<1000)return {rate:configured,source:'studio',date:null};
  if(cached && Date.now()<cached.expires)return cached.value;
  const value=(async()=>{
    try {
      const r=await fetch(feed,{signal:AbortSignal.timeout(4000),redirect:'error'});
      if(!r.ok)throw new Error('ECB rate unavailable');
      return ecbUsdToThb(await r.text());
    } catch {
      if(cached)cached.expires=Date.now()+60000;
      return {rate:null,source:null,date:null};
    }
  })();
  cached={expires:Date.now()+3600000,value};
  return value;
}
