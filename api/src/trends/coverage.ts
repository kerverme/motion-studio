import type {Platform} from './policy.js';
import type {SocialEvidence} from './evidence.js';

type Call = {capability:string; received?:number; error?:string};
type Warning = {capability?:string; code:string};

export function requestedPlatforms(platform:string):Platform[] {
  if (platform==='tiktok'||platform==='instagram'||platform==='youtube') return [platform];
  return ['tiktok','instagram'];
}

export function platformCoverage(platform:string, calls:Call[]=[], warnings:Warning[]=[], evidence?:SocialEvidence[]) {
  return requestedPlatforms(platform).map(name=>{
    const belongs = (capability?:string) => capability?.split('/')[0]===name;
    const attempts=calls.filter(call=>belongs(call.capability));
    const success=attempts.filter(call=>!call.error);
    const errors=[...new Set([
      ...attempts.flatMap(call=>call.error?[call.error]:[]),
      ...warnings.filter(warning=>belongs(warning.capability)).map(warning=>warning.code),
    ])];
    const posts=evidence?.filter(item=>item.platform===name).length??null;
    const found=posts===null?success.some(call=>(call.received??0)>0):posts>0;
    const state=errors.length?(success.length?'partial':'unavailable')
      :success.length?(found?'complete':'no_results'):'not_checked';
    return {platform:name,state,posts,errors};
  });
}
