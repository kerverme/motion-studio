import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9_]{1,24}$/);
const Name = z.string().trim().min(1).max(20);

/** The story is agreed before artwork is generated. Legacy drafts have no plan. */
export const Storyboard = z.object({
  story_mode: z.enum(['name_story','general']).optional(),
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
  plan.shots.forEach((shot, i) => {
    if (plan.story_mode !== 'general' && !shot.characters.length) ctx.addIssue({code:'custom',path:['shots',i,'characters'],message:'name stories require a character in every shot'});
    if (new Set(shot.characters).size !== shot.characters.length) {
      ctx.addIssue({ code: 'custom', path: ['shots', i, 'characters'], message: 'character names must be unique within a shot' });
    }
  });
});
export type StoryboardT = z.infer<typeof Storyboard>;

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
