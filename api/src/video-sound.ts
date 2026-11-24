// The director's soundtrack notes can describe narration, music, ambience, or silence.
// Only a deliberately selected external sound effect belongs in the ElevenLabs quote.
export type SoundEffect={text:string;duration_seconds:number};
type Selection={effect:SoundEffect|null;origin:'owner'|'director'|null};
const none:Selection={effect:null,origin:null};
function plain(value:unknown) {return typeof value==='string'?value.normalize('NFKC').toLowerCase().replace(/[‐‑–—_-]/gu,' ').replace(/\s+/g,' ').trim():'';}
export function silentSoundEffect(value:unknown) {
  const s=plain(value);
  return !s || /^(?:none|n\/?a|silent|silence|mute|off|ไม่มี|เงียบ|ปิด)[.!?\s]*$/u.test(s) ||
    /\b(?:no|without|skip|avoid|omit|disable|do not (?:add|use|generate)|don't (?:add|use|generate))\s+(?:(?:any|added|additional|special|external|dedicated|separate|extra|paid)\s+)*(?:sound effects?|special effects?|sfx|foley)\b/u.test(s) ||
    /\b(?:sound effects?|sfx|foley)\s*[:=\-]?\s*(?:(?:are |is )?(?:not (?:needed|required|used)|disabled|off|none))\b/u.test(s) ||
    /\b(?:(?:only|just)\s+(?:ambient sound|background music|music|narration|voice ?over|speech|dialogue)|(?:ambient sound|background music|music|narration|voice ?over|speech|dialogue)\s+only)\b/u.test(s) ||
    /^(?:(?:soft|light|background|natural|quiet|gentle)\s+)*(?:music|ambience|ambiance|atmosphere|narration|voice ?over|dialogue)[.!\s]*$/u.test(s) ||
    /(?:ไม่มี|ไม่ต้อง(?:มี|ใส่|ใช้|สร้าง|เพิ่ม)?|ไม่(?:ใช้|ใส่|สร้าง|เพิ่ม)|งด|ปิด)(?:\s*เสียง)?\s*(?:เอฟเฟ[กค]ต์?|เอฟเฟค|ประกอบ|พิเศษ|ซาวด์เอฟเฟกต์|sfx)|(?:เฉพาะ|เพียง)(?:เสียง)?(?:บรรยาย|พูด|ดนตรี|เพลง)|(?:เสียง(?:บรรยาย|พูด|ดนตรี)|ดนตรี|เพลง)(?:อย่างเดียว|เท่านั้น|ล้วน)/u.test(s);
}
function same(a:any,b:any){return !!a&&!!b&&a.text===b.text&&a.duration_seconds===b.duration_seconds;}
export function selectedSound(scene:any):SoundEffect|null {
  const p=scene?.production,selected=p?.sfx;
  if(!selected || p.audio || silentSoundEffect(selected.text)) return null;
  if(p.sfx_origin==='owner' || (!p.sfx_origin && !scene.direction?.sound_effect && plain(selected.text)!==plain(scene.direction?.audio))) return selected;
  if(scene.direction?.sound_effect?.kind==='none' || (scene.direction?.audio && silentSoundEffect(scene.direction.audio))) return null;
  return selected;
}
export function planSound(scene:any,edited:number,edit:{audio:boolean;sfx?:SoundEffect|null},previousScene:any,verified:boolean):Selection {
  if(edit.audio) return none;
  const design=scene.direction?.sound_effect;
  const previous=previousScene?.production;
  if(previous) {
    if(edit.sfx && !same(edit.sfx,previous.sfx)) return silentSoundEffect(edit.sfx.text)?none:{effect:edit.sfx,origin:'owner'};
    if(previous.sfx && !edit.sfx) return none;
    if(same(edit.sfx,previous.sfx) && previous.sfx_origin==='owner') return silentSoundEffect(edit.sfx?.text)?none:{effect:edit.sfx!,origin:'owner'};
    // Existing selections survive an unchanged direction; a cleared field stays off across edits.
    const oldDesign=previousScene.direction?.sound_effect;
    if(design?.kind===oldDesign?.kind && design?.text===oldDesign?.text && design?.duration_seconds===oldDesign?.duration_seconds) {
      const effective=selectedSound({...scene,production:{...previous,...edit}});
      return effective?{effect:effective,origin:previous.sfx_origin || 'director'}:none;
    }
  }
  if(edited<.5 || !verified || design?.kind!=='effect' || silentSoundEffect(design.text) || (scene.direction.audio && silentSoundEffect(scene.direction.audio))) return none;
  return {effect:{text:design.text,duration_seconds:Math.min(design.duration_seconds,edited)},origin:'director'};
}
export function correctedSoundPlan(plan:any) {
  if(!Array.isArray(plan?.shots)) return plan;
  let changed=false;
  const shots=plan.shots.map((s:any)=>{
    if(!s.production?.sfx || selectedSound(s)) return s;
    changed=true;
    return {...s,production:{...s.production,sfx:null,sfx_origin:null}};
  });
  return changed?{...plan,shots}:plan;
}
export function obsoleteSoundCharge(plan:any,quote:any) {
  return quote?.eleven?.some((x:any)=>{
    if(!x.slot?.startsWith('sfx:')) return false;
    const scene=plan?.shots?.find((s:any)=>'sfx:'+s.id===x.slot);
    return !same(selectedSound(scene),x);
  }) || false;
}
