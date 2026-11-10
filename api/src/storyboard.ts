import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9_]{1,24}$/);
const Name = z.string().trim().min(1).max(20);
export const NarrativeDirection = z.object({
  premise:z.string().trim().min(10).max(400), central_question:z.string().trim().min(8).max(220),
  throughline:z.string().trim().min(10).max(400), payoff:z.string().trim().min(10).max(400),
}).strict();
export const ShotContinuity = z.object({from:z.string().trim().min(5).max(300),to:z.string().trim().min(5).max(300)}).strict();
export const MotionBeat = z.object({start:z.number().min(0).max(1),end:z.number().min(0).max(1),action:z.string().trim().min(8).max(300),purpose:z.string().trim().min(8).max(300)}).strict().refine(beat=>beat.end>beat.start,'motion beat end must be after its start');
export const SoundPolicy = z.object({mode:z.enum(['designed','quiet']),owner_quote:z.string().trim().max(250).optional()}).strict();


/** The story is agreed before artwork is generated. Legacy drafts have no plan. */
export const Storyboard = z.object({
  story_mode: z.enum(['name_story','general']).optional(),
  recurring_character: z.boolean().optional(),
  direction_version:z.literal(1).optional(),
  narrative:NarrativeDirection.optional(),
  sound_policy:SoundPolicy.optional(),
  script: z.array(z.object({
    id: Id, text: z.string().min(3).max(500),
    beat: z.enum(['hook', 'rehook', 'info', 'payoff', 'cta']),
  }).strict()).min(4).max(14),
  shots: z.array(z.object({
    seg: Id,
    visual: z.string().trim().min(10).max(1200),
    action: z.string().trim().min(3).max(600),
    camera: z.string().trim().min(3).max(300),
    characters: z.array(Name).max(4),
    continuity:ShotContinuity.optional(),
    motion_beats:z.array(MotionBeat).min(2).max(5).optional(),
  }).strict()).min(4).max(14),
  character_notes: z.string().trim().min(10).max(3000),
}).strict().superRefine((plan, ctx) => {
  const ids = plan.script.map(s => s.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['script'], message: 'script ids must be unique' });
  const shots = plan.shots.map(s => s.seg);
  if (new Set(shots).size !== shots.length) ctx.addIssue({ code: 'custom', path: ['shots'], message: 'shot ids must be unique' });
  if (ids.length !== shots.length || ids.some((id, i) => shots[i] !== id)) {
    ctx.addIssue({ code: 'custom', path: ['shots'], message: 'one shot per narration segment, in narration order' });
  }
  if (plan.recurring_character && !plan.shots[0]?.characters.some(name => plan.shots.every(shot => shot.characters.includes(name)))) {
    ctx.addIssue({code:'custom',path:['shots'],message:'recurring character mode requires the same character in every shot'});
  }
  if(plan.direction_version===1){
    if(!plan.narrative)ctx.addIssue({code:'custom',path:['narrative'],message:'directed stories need one premise, central question, throughline and payoff'});
    if(!plan.sound_policy)ctx.addIssue({code:'custom',path:['sound_policy'],message:'directed stories need a sound policy'});
    plan.shots.forEach((shot,i)=>{
      if(!shot.continuity)ctx.addIssue({code:'custom',path:['shots',i,'continuity'],message:'describe the incoming state and the outgoing state that carries the story onward'});
      if(!shot.motion_beats?.length){ctx.addIssue({code:'custom',path:['shots',i,'motion_beats'],message:'plan meaningful actions throughout this shot, not only mouth movement or a static diagram'});return;}
      const beats=[...shot.motion_beats].sort((a,b)=>a.start-b.start);let covered=0;
      for(const beat of beats){if(beat.start-covered>0.12)ctx.addIssue({code:'custom',path:['shots',i,'motion_beats'],message:'motion beats leave a long unplanned hold; connect actions across the shot'});covered=Math.max(covered,beat.end);}
      if(beats[0].start>0.08 || covered<0.95)ctx.addIssue({code:'custom',path:['shots',i,'motion_beats'],message:'motion beats must cover the beginning through the end of the shot'});
    });
  }
  plan.shots.forEach((shot, i) => {
    if (plan.story_mode !== 'general' && !shot.characters.length) ctx.addIssue({code:'custom',path:['shots',i,'characters'],message:'name stories require a character in every shot'});
    if (new Set(shot.characters).size !== shot.characters.length) {
      ctx.addIssue({ code: 'custom', path: ['shots', i, 'characters'], message: 'character names must be unique within a shot' });
    }
  });
});
export type StoryboardT = z.infer<typeof Storyboard>;

const SegmentRevision = z.object({
  seg: Id,
  text: z.string().min(3).max(500).optional(),
  beat: z.enum(['hook', 'rehook', 'info', 'payoff', 'cta']).optional(),
  visual: z.string().trim().min(10).max(1200).optional(),
  action: z.string().trim().min(3).max(600).optional(),
  camera: z.string().trim().min(3).max(300).optional(),
  characters: z.array(Name).max(4).optional(),
  continuity:ShotContinuity.optional(),
  motion_beats:z.array(MotionBeat).min(2).max(5).optional(),
}).strict().refine(change => Object.keys(change).length > 1, 'include at least one changed narration or shot field');
const StoryRevision = z.object({segments:z.array(SegmentRevision).min(1).max(14)}).strict();

/** Partial repairs retain the canonical text and shot details for every omitted segment.
 * Full plan_story remains necessary for adding, removing or reordering segments.
 */
export function reviseStoryboard(saved: StoryboardT, input: unknown): StoryboardT {
  const revision = StoryRevision.parse(input);
  const ids = revision.segments.map(change => change.seg);
  if (new Set(ids).size !== ids.length) throw new Error('revise_story segment ids must be unique');
  for (const seg of ids) if (!saved.script.some(line => line.id === seg) || !saved.shots.some(shot => shot.seg === seg)) {
    throw new Error(`revise_story segment ${seg} is not in the saved storyboard; use plan_story for structural changes`);
  }
  const changes = new Map(revision.segments.map(change => [change.seg, change]));
  return Storyboard.parse({
    ...saved,
    script: saved.script.map(line => {
      const change = changes.get(line.id);
      return change ? {...line,...(change.text !== undefined ? {text:change.text} : {}),...(change.beat !== undefined ? {beat:change.beat} : {})} : line;
    }),
    shots: saved.shots.map(shot => {
      const change = changes.get(shot.seg);
      if (!change) return shot;
      const {seg,text,beat,...fields} = change;
      return {...shot,...fields};
    }),
  });
}

type Token = { kind: 'word' | 'string' | 'punct'; value: string };

/** Only direct literal calls count. Text inside comments/docstrings cannot fake a cast appearance.
 * This is a consistency check, not a Python security boundary; worker AST validation and its
 * sandbox remain authoritative. Rendering also verifies every referenced cast member exists.
 */
export function personCalls(code: string): string[] {
  const tokens: Token[] = [];
  for (let i = 0; i < code.length;) {
    const ch = code[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (ch === '"' || ch === "'") {
      const triple = code.slice(i, i + 3) === ch.repeat(3);
      const close = triple ? ch.repeat(3) : ch;
      i += close.length;
      let value = '', ended = false;
      while (i < code.length) {
        if (code.slice(i, i + close.length) === close) { i += close.length; ended = true; break; }
        if (code[i] === '\\' && i + 1 < code.length) {
          const next = code[++i];
          if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(code.slice(i + 1, i + 5))) {
            value += String.fromCharCode(parseInt(code.slice(i + 1, i + 5), 16)); i += 5;
          } else { value += next === 'n' ? '\n' : next === 't' ? '\t' : next; i++; }
        } else value += code[i++];
      }
      tokens.push({ kind: 'string', value: ended ? value : '' });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i++;
      while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++;
      tokens.push({ kind: 'word', value: code.slice(start, i) });
      continue;
    }
    tokens.push({ kind: 'punct', value: ch }); i++;
  }
  const names: string[] = [];
  for (let i = 0; i + 4 < tokens.length; i++) {
    if (tokens[i].kind === 'word' && tokens[i].value === 'c' && tokens[i + 1].value === '.' &&
      tokens[i + 2].kind === 'word' && tokens[i + 2].value === 'person' && tokens[i + 3].value === '(' &&
      tokens[i + 4].kind === 'string' && tokens[i + 5]?.value === ',') names.push(tokens[i + 4].value);
  }
  return [...new Set(names)];
}

export function validateStoryboardDraft(plan: StoryboardT, draft: {
  script: { id: string; text: string; beat?: string }[];
  scenes: { seg: string; type: string; code?: string }[];
  cast: { name: string }[];
  storyboard?: unknown;
  recurring_character?: boolean;
}): string[] {
  const errors: string[] = [];
  const parsed = Storyboard.safeParse(plan);
  if (!parsed.success) return parsed.error.issues.map(i => `storyboard ${i.path.join('.')}: ${i.message}`);
  const submitted = Storyboard.safeParse(draft.storyboard);
  if (!submitted.success || JSON.stringify(submitted.data) !== JSON.stringify(parsed.data)) {
    errors.push('storyboard must match the saved plan_story result; revise the plan before changing the story');
  }
  if (draft.script.length !== plan.script.length || plan.script.some((s, i) => {
    const actual = draft.script[i];
    return !actual || actual.id !== s.id || actual.text !== s.text || actual.beat !== s.beat;
  })) errors.push('script must match the saved storyboard exactly, including narration order and beats');
  if (!!draft.recurring_character !== !!parsed.data.recurring_character) errors.push('recurring character setting must match the saved storyboard');
  const names = new Set(draft.cast.map(c => c.name));
  if (names.size !== draft.cast.length) errors.push('cast names must be unique');
  if (draft.scenes.length !== plan.shots.length || new Set(draft.scenes.map(s => s.seg)).size !== draft.scenes.length) {
    errors.push('provide exactly one custom scene per storyboard shot');
  }
  for (const shot of plan.shots) {
    const scene = draft.scenes.find(s => s.seg === shot.seg);
    if (!scene) { errors.push(`storyboard ${shot.seg}: missing scene`); continue; }
    if (scene.type !== 'custom') errors.push(`storyboard ${shot.seg}: every scene must be custom, including the opening`);
    const drawn = personCalls(scene.code || '');
    for (const name of shot.characters) {
      if (!names.has(name)) errors.push(`storyboard ${shot.seg}: character "${name}" is not in cast`);
      if (!drawn.includes(name)) errors.push(`storyboard ${shot.seg}: draw "${name}" with a direct c.person("${name}", ...) call`);
    }
    for (const name of drawn) if (!names.has(name)) errors.push(`scene ${shot.seg}: c.person references unknown cast member "${name}"`);
  }
  for (const scene of draft.scenes) if (!plan.shots.some(s => s.seg === scene.seg)) errors.push(`scene ${scene.seg}: not in storyboard`);
  return [...new Set(errors)];
}
