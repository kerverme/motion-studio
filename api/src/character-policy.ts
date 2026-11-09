export type PresenterKind = 'legacy' | 'cat';

/** New drafts opt into the cat design; stored drafts without this column keep their legacy design. */
export function parsePresenterKind(value: unknown, fallback: PresenterKind = 'cat'): PresenterKind {
  if (value === undefined) return fallback;
  if (value !== 'legacy' && value !== 'cat') throw new Error('รูปแบบผู้เล่าต้องเป็น cat หรือ legacy');
  return value;
}

/** Omitted API fields keep legacy drafts character-optional; the composer opts in explicitly. */
export function parseRecurringCharacter(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('ตัวเลือกตัวละครต่อเนื่องต้องเป็น true หรือ false');
  return value;
}

/** The stored owner setting wins over model-generated or stale JSON flags. */
export function withCharacterPolicy<T extends Record<string, any>>(value: T, enabled: boolean): T & {recurring_character?:boolean} {
  const result = {...value};
  delete result.recurring_character;
  return (enabled ? {...result,recurring_character:true} : result) as T & {recurring_character?:boolean};
}

export function referencePresenterProblem(plan: {shots:{seg:string;characters:string[]}[]}, enabled: boolean, referenceName?: string): string | null {
  if (!enabled || !referenceName) return null;
  const missing = plan.shots.filter(shot=>!shot.characters.includes(referenceName)).map(shot=>shot.seg);
  return missing.length ? `recurring reference character "${referenceName}" must appear in every shot; missing from: ${missing.join(', ')}` : null;
}

export function characterPolicyPrompt(enabled: boolean, referenceName?: string, presenterKind: PresenterKind = 'cat'): string {
  if (!enabled) return 'Recurring cartoon presenter is off. Do not require or invent a presenter just to satisfy a recurring-character rule; the story mode and explicitly selected references still apply.';
  return `The owner explicitly requests one recurring cartoon presenter throughout this explainer. ${referenceName
    ? `Use the first selected reference character ${JSON.stringify(referenceName)} as that presenter. Study the provided reference and keep the same identity, face, hairstyle and clothing in every shot; likeness remains a stylised interpretation, never a guaranteed exact copy.`
    : presenterKind === 'cat'
      ? 'Invent ONE fictional recognisable cartoon orange tabby CAT presenter, without asking the owner for a name or photo. Give the cat a short Thai cast name, cream muzzle, visible triangular ears, whiskers, paws and tail, orange tabby markings, and the SAME blue hoodie in every shot. Describe these exact identity features in character_notes and portrait_description and draw a bespoke full-body portrait_code. It must be an actual cartoon cat, not a human with cat ears. Use the named cast portrait through c.person; never substitute the generic c.cat mascot or a stock cat drawing. The c.person API renders any named custom portrait and does not require human anatomy.'
      : 'Invent ONE fictional cartoon presenter suited to this topic, without asking the owner for a name or photo. Give it a short Thai cast name and a distinctive face, hairstyle and outfit; describe these once in character_notes and portrait_description.'}
The SAME named presenter must be in cast and in EVERY shot.characters, including opening and closing. Draw the same saved portrait with a direct c.person("name", ...) call in EVERY scene, visible from opening frame zero through the end of EVERY shot, inside the safe crop with a readable face and large enough to follow. Never fade out, exit the frame, swap identity or reduce the presenter to a tiny decorative sticker. Reuse the identity and clothing; vary pose, expression, gesture, position and framing to demonstrate that scene’s narration. The presenter points to objects, diagrams and examples instead of replacing the explanation. Do not leave the presenter off-screen, hidden, tiny, or appearing only late in a shot. Additional characters are optional.
This explicitly requests a character even in general storytelling mode. Keep the topic-led opening and cover; do not turn it into a nickname-count series. Source authors, clinicians, researchers and named experts remain attribution, never automatic protagonists or a claimed identity for the fictional presenter. A fictional health explainer does not impersonate a doctor, diagnose the viewer or turn unverified research notes into medical advice.`;
}
