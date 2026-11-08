import { z } from 'zod';
import { personCalls, type StoryboardT } from './storyboard.js';

const Name = z.string().trim().min(1).max(20);
const Id = z.string().regex(/^[a-z0-9_]{1,24}$/);
const DrawingCode = (max: number) => z.string().min(30).max(max).refine(
  code => /def\s+draw\s*\(\s*c\s*,\s*t\s*,\s*p\s*\)/.test(code),
  'drawing code must define def draw(c,t,p):',
);

const Character = z.object({
  name: Name,
  portrait_code: DrawingCode(9000),
  portrait_description: z.string().trim().min(1).max(2500),
}).passthrough();
const Scene = z.object({ seg: Id, type: z.literal('custom'), code: DrawingCode(6000) }).passthrough();
export const Artwork = z.object({ art: z.string().max(9000), art_saved: z.boolean().optional(), cast: z.array(Character).max(4), scenes: z.array(Scene).max(14) });
export type ArtworkState = z.infer<typeof Artwork>;

export const emptyArtwork = (): ArtworkState => ({ art: '', cast: [], scenes: [] });

/** Small drawing calls keep one slow reasoning response from rewriting a whole episode. */
export const ARTWORK_TOOLS = [
  {
    name: 'save_art', description: 'Save or replace shared drawing helper functions only. Do not redraw scenes or portraits in this call.',
    input_schema: { type: 'object', required: ['art'], properties: { art: { type: 'string', maxLength: 9000 } }, additionalProperties: false },
  },
  {
    name: 'draw_character', description: 'Draw ONE named storyboard character: bespoke face and full body. Replaces only this character; other saved artwork remains.',
    input_schema: { type: 'object', required: ['character'], additionalProperties: false, properties: {
      character: { type: 'object', required: ['name', 'portrait_code', 'portrait_description'], properties: {
        name: { type: 'string', maxLength: 20 }, portrait_code: { type: 'string', maxLength: 9000 }, portrait_description: { type: 'string', maxLength: 2500 },
      }, additionalProperties: true },
    } },
  },
  {
    name: 'draw_scene', description: 'Draw ONE saved storyboard shot as custom code. Replaces only this scene; reuse saved portraits and art helpers.',
    input_schema: { type: 'object', required: ['scene'], additionalProperties: false, properties: {
      scene: { type: 'object', required: ['seg', 'type', 'code'], properties: {
        seg: { type: 'string', maxLength: 24 }, type: { type: 'string', enum: ['custom'] }, code: { type: 'string', maxLength: 6000 },
      }, additionalProperties: true },
    } },
  },
];

function assertPlanReferences(state: ArtworkState, plan: StoryboardT) {
  const names = new Set(plan.shots.flatMap(shot => shot.characters));
  if (new Set(state.cast.map(c => c.name)).size !== state.cast.length) throw new Error('saved character names must be unique');
  if (new Set(state.scenes.map(s => s.seg)).size !== state.scenes.length) throw new Error('saved scene ids must be unique');
  for (const character of state.cast) if (!names.has(character.name)) throw new Error(`character ${character.name} is not in the storyboard`);
  for (const scene of state.scenes) {
    const shot = plan.shots.find(s => s.seg === scene.seg);
    if (!shot) throw new Error(`scene ${scene.seg} is not in the storyboard`);
    const drawn = personCalls(scene.code);
    for (const name of shot.characters) if (!drawn.includes(name)) throw new Error(`scene ${scene.seg}: draw planned character ${name} with a direct c.person call`);
    for (const name of drawn) if (!names.has(name)) throw new Error(`scene ${scene.seg}: unknown storyboard character ${name}`);
  }
}

/** Returns a new snapshot; rejected edits leave previously saved work intact. */
export function updateArtwork(state: ArtworkState, tool: string, input: unknown, plan: StoryboardT): ArtworkState {
  const previous = Artwork.parse(state);
  let next: ArtworkState;
  if (tool === 'save_art') {
    const item = z.object({ art: z.string().max(9000) }).strict().parse(input);
    next = { ...previous, art: item.art, art_saved: true };
  } else if (tool === 'draw_character') {
    const { character } = z.object({ character: Character }).strict().parse(input);
    const index = previous.cast.findIndex(c => c.name === character.name);
    next = { ...previous, cast: index < 0 ? [...previous.cast, character] : previous.cast.map((c, i) => i === index ? character : c) };
  } else if (tool === 'draw_scene') {
    const { scene } = z.object({ scene: Scene }).strict().parse(input);
    const index = previous.scenes.findIndex(s => s.seg === scene.seg);
    next = { ...previous, scenes: index < 0 ? [...previous.scenes, scene] : previous.scenes.map((s, i) => i === index ? scene : s) };
  } else throw new Error(`unknown artwork tool ${tool}`);
  const checked = Artwork.parse(next);
  assertPlanReferences(checked, plan);
  return structuredClone(checked);
}

export function artworkComplete(state: ArtworkState, plan: StoryboardT): boolean {
  try {
    const checked = Artwork.parse(state);
    assertPlanReferences(checked, plan);
    const requiredNames = new Set(plan.shots.flatMap(s => s.characters));
    return checked.cast.length === requiredNames.size && [...requiredNames].every(name => checked.cast.some(c => c.name === name)) &&
      checked.scenes.length === plan.shots.length && plan.shots.every(s => checked.scenes.some(scene => scene.seg === s.seg));
  } catch { return false; }
}

/** Staged drawings always win; full episode submissions remain compatible for unsaved pieces. */
export function mergeArtwork(metadata: Record<string, any>, state: ArtworkState): Record<string, any> {
  const checked = Artwork.parse(state);
  const merge = (supplied: unknown, saved: Record<string, any>[], key: string) => {
    const items = Array.isArray(supplied) ? supplied.filter(i => i && typeof i === 'object' && !Array.isArray(i)) : [];
    const used = new Set<string>();
    const merged = items.map(item => {
      const staged = saved.find(s => s[key] === item[key]);
      if (staged) used.add(staged[key]);
      return staged ? { ...item, ...staged } : item;
    });
    return [...merged, ...saved.filter(item => !used.has(item[key]))];
  };
  const result = { ...metadata };
  // Empty state must not introduce defaults that overwrite a complete legacy submit.
  if (checked.art_saved || checked.art || checked.cast.length || checked.scenes.length) {
    if (checked.art_saved || checked.art) result.art = checked.art;
    result.cast = merge(metadata.cast, checked.cast, 'name');
    result.scenes = merge(metadata.scenes, checked.scenes, 'seg');
  }
  return structuredClone(result);
}
