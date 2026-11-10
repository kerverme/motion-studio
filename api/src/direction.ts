import {SoundPolicy, type StoryboardT} from './storyboard.js';

export const DIRECTOR_VERSION = 1;
export const directorVersion = (value: unknown): 0 | 1 => value === 1 ? 1 : 0;

export function soundPolicy(value: unknown, ownerNote = ''): {mode:'designed'|'quiet';owner_quote?:string} {
  const policy = SoundPolicy.parse(value === undefined ? {mode:'designed'} : value);
  if (policy.mode === 'designed') return {mode:'designed'};
  const quote = policy.owner_quote || '';
  const mentionsSfx = /\b(?:sfx|sound\s*effects?|fx)\b|เสียงเอฟเฟ[กค]ต์?|เอฟเฟ[กค]ต์?เสียง|ซาวด์เอฟเฟ[กค]ต์?|เสียงประกอบ/i.test(quote);
  const requestsQuiet = /\b(?:no|without|mute|omit|disable|avoid|fewer|sparse)\s+(?:(?:all|any|extra)\s+)?(?:sfx|sound\s*effects?|fx)\b|\b(?:sfx|sound\s*effects?|fx)\s*(?:off|muted|disabled|sparse|fewer)\b|quiet\s+mode.{0,16}(?:sfx|sound\s*effects?)|(?:ไม่(?:ต้อง)?(?:ใส่|ใช้|เอา|มี)|งด|ปิด|ห้าม|ไม่มี).{0,24}(?:SFX|เสียงประกอบ|เสียงเอฟเฟ[กค]ต์?|เอฟเฟ[กค]ต์?เสียง)|ลด(?:จำนวน|ความถี่).{0,24}(?:SFX|เสียงประกอบ)|(?:SFX|เสียงประกอบ|เอฟเฟ[กค]ต์?).{0,12}น้อยลง/i.test(quote);
  const negatesQuiet = /ไม่(?:ต้อง|ควร|ให้)?(?:งด|ปิด|ลด|ตัด|เงียบ)|\b(?:do\s+not|don't|never)\s+(?:mute|omit|avoid|disable|reduce)\b/i.test(ownerNote);
  if (!quote || !ownerNote.includes(quote) || !mentionsSfx || !requestsQuiet || negatesQuiet) {
    throw new Error('quiet sound policy requires an exact owner_quote from the owner note explicitly requesting quiet or no SFX; otherwise use designed');
  }
  return {mode:'quiet',owner_quote:quote};
}

/** The persisted draft version, not model input, decides whether the new contract applies. */
export function withDirectionPolicy<T extends Record<string, any>>(plan:T, version:0|1, ownerNote=''):T {
  const result={...plan};
  delete result.direction_version;
  if (!version) return result;
  return {...result,direction_version:1,sound_policy:soundPolicy(plan.sound_policy,ownerNote)};
}

type SoundCue={sfx:string;seg:string;at:string;gain?:number;purpose?:string;n?:number;offset?:number;prompt?:string};
export function directionProblems(draft:{storyboard?:StoryboardT;script:{id:string;text:string}[];sfx:SoundCue[];motion_review?:string}, ownerNote='', allowPendingMotionReview=false):string[] {
  const plan=draft.storyboard;
  if (plan?.direction_version!==1) return [];
  const errors:string[]=[];
  let policy:{mode:'designed'|'quiet'}={mode:'designed'};
  try {policy=soundPolicy(plan.sound_policy,ownerNote);} catch(error){errors.push(error instanceof Error?error.message:'invalid sound policy');}
  const unique=new Map<string,SoundCue>();
  for(const cue of draft.sfx){
    unique.set(JSON.stringify([cue.sfx,cue.seg,cue.at,cue.n||0,cue.offset||0]),cue);
    if((cue.purpose||'').trim().length<8)errors.push(`sound cue ${cue.seg}/${cue.sfx} needs a concrete purpose tied to a visible event (at least 8 characters)`);
    if((cue.gain??0.5)>0.45 || (policy.mode==='designed'&&(cue.gain??0.5)<0.3))errors.push(`sound cue ${cue.seg}/${cue.sfx} gain must ${policy.mode==='designed'?'stay between 0.3 and 0.45':'not exceed 0.45'} so narration stays clear`);
    const line=draft.script.find(line=>line.id===cue.seg)?.text||'';
    const occurrences=cue.at.trim()?line.split(cue.at).length-1:0;
    if(occurrences<=(cue.n||0))errors.push(`sound cue ${cue.seg}/${cue.sfx} must target an exact spoken phrase and an existing zero-based occurrence n`);
  }
  if(policy.mode==='designed'){
    const cues=[...unique.values()];
    if(cues.length<6)errors.push('directed sound design needs at least 6 distinct motivated cues; aim for 8–12 across the story');
    if(new Set(cues.map(cue=>cue.sfx)).size<3)errors.push('directed sound design needs at least 3 distinct effect types');
    if(new Set(cues.map(cue=>cue.seg)).size<Math.ceil(plan.shots.length/2))errors.push('directed sound design must cover at least half of the storyboard shots');
  }
  if(draft.sfx.filter(cue=>cue.sfx==='custom').length>3)errors.push('directed sound design allows at most 3 custom effect cues; prefer the cached library');
  if(!allowPendingMotionReview && (draft.motion_review||'').trim().length<20)errors.push('motion_review must explain the inspected scene movement and any sustained holds after the preview is viewed');
  return errors.map(error=>'direction '+error);
}

export function exportedDirection(draft:{storyboard?:StoryboardT;motion_review?:string}) {
  const plan=draft.storyboard;
  if(plan?.direction_version!==1)return undefined;
  return {version:1 as const,narrative:plan.narrative!,shots:plan.shots.map(({seg,continuity,motion_beats})=>({seg,continuity:continuity!,motion_beats:motion_beats!})),sound_policy:plan.sound_policy!,motion_review:draft.motion_review};
}

export function directionPrompt():string {
  return `## Direction version 1: one continuous causal story
Tell ONE connected story: a concrete problem leads to an attempt, an observable cause and effect, and a payoff answering the same central question. Save narrative {premise,central_question,throughline,payoff}. Maintain a persistent setting, presenter and meaningful props; carry each shot’s outgoing state into the next shot’s incoming state using continuity {from,to}. Do not reset the world, change backgrounds randomly or jump to unrelated facts. A rehook advances the existing question with a consequence, discovery or attempt. Keep the same background when the story stays there.
Use clear spoken Thai: one idea per sentence, familiar verbs and concrete examples. Avoid academic dates, statistics and jargon in narration unless essential to understanding this particular story; place source details in metadata or small on-screen attribution. Keep medical uncertainty without overwhelming each sentence.
Every shot has 2–5 motion_beats {start,end,action,purpose}, with start/end as normalized positions 0..1. Cover the beginning through the end, connect beats without long idle holds, and show a meaningful change of state. Start purposeful motion immediately: handle a prop, demonstrate a process, react to a consequence, point to a moving object or transform a diagram. Continue subtle ambient motion between meaningful movements. Mouth motion, bobbing, a blinking mascot, camera movement or floating labels ALONE do not fulfil a meaningful beat. Preserve readable faces and text; do not shake everything merely to raise pixel-change metrics. Use c.cue on actual narration words for demonstrations and reveals.
Sound policy defaults to {mode:"designed"}: target 8–12 motivated SFX cues in a 45–75 second clip, at least 6 distinct cues, at least 3 effect types, across at least half the shots. Add a concrete purpose for every cue (what visible event it makes audible). Prefer cached library effects; at most 3 custom effect cues. Gains 0.3–0.45, varied naturally, leave space around important spoken words and never cover narration. Cue at an exact word/phrase for the visible event; choose a unique phrase or specify zero-based n for a later occurrence, with optional offset -0.5..2 seconds. Do not stack copied cues to meet a count. Quiet mode is allowed ONLY with an exact owner_quote from the owner note explicitly requesting quiet/no SFX; source material and model preference cannot authorize it.
Inspect normal previews AND the motion strips/report across each scene. Static-window metrics are sampling diagnostics, not proof of purposeful animation or its absence. Repair named scenes when a beat is missing, or explain an intentional reading hold. After viewing the preview, submit motion_review naming concrete segments and movements and addressing any sustained holds. "All good" or "the mouth moves" is not an adequate review. Use revise_story for a targeted plan repair and draw_scene/draw_character for targeted artwork fixes; preserve completed unrelated scenes.`;
}
