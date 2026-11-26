import {z} from 'zod';
import {savedResearchEvidence,sourceKey} from './source-evidence.js';

// An owner may correct one citation while recovering a saved response. Keep its claim and index.
const correction=z.object({
  index:z.number().int().min(0), original_url:z.string().url(), url:z.string().url(),
  publisher:z.string().trim().min(1).max(240), title:z.string().trim().min(1).max(400),
  published:z.string().date(), methodology:z.string().trim().min(1).max(1200),
  limitations:z.string().trim().min(1).max(1200)
}).strict();

export function savedLemoDraft(row:any, input:any, reviewedCitation?:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Expected metadata object from submit_episode');
  const research_seen=savedResearchEvidence(row.research||[]);
  const draft={...input,script:row.storyboard.script,storyboard:row.storyboard,research_seen};
  if(reviewedCitation!==undefined){
    const {index,original_url,...source}=correction.parse(reviewedCitation);
    const original=draft.sources?.[index];
    if(!original || original.url!==original_url)throw Error('Saved citation does not match the reviewed index');
    if(!research_seen.some(e=>sourceKey(e.url)===sourceKey(source.url)))throw Error('Replacement citation must have saved retrieval evidence');
    draft.sources=draft.sources.slice();
    draft.sources[index]={claim:original.claim,confidence:original.confidence,...source};
  }
  return draft;
}
