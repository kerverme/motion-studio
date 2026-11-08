import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkComplete, emptyArtwork, mergeArtwork, reconcileArtwork, updateArtwork } from './art-batches.js';
import type { StoryboardT } from './storyboard.js';

const plan: StoryboardT = {
  script: ['s1', 's2', 's3', 's4'].map(id => ({ id, text: 'เรื่องเล่าของเบล', beat: 'info' })),
  shots: ['s1', 's2', 's3', 's4'].map(seg => ({ seg, visual: 'A new scene in a market', action: 'walk', camera: 'wide shot', characters: ['เบล'] })),
  character_notes: 'A distinctive face and outfit',
};
const character = (code = 'def draw(c,t,p):\n    c.circle(0,0,90,"tan")') => ({ name: 'เบล', portrait_code: code, portrait_description: 'Long face and dark hair', top_color: [20, 40, 80] });
const scene = (seg: string, code = 'def draw(c,t,p):\n    c.person("เบล",540,700,200)') => ({ seg, type: 'custom', code, headline: { text: 'เบลมาแล้ว' } });

test('saves one portrait or scene at a time and replaces edited keys without duplicates', () => {
  const initial = emptyArtwork();
  const one = updateArtwork(initial, 'draw_character', { character: character() }, plan);
  const two = updateArtwork(one, 'draw_scene', { scene: scene('s1') }, plan);
  const corrected = character('def draw(c,t,p):\n    c.ellipse(0,0,75,110,"tan")');
  const three = updateArtwork(two, 'draw_character', { character: corrected }, plan);
  assert.deepEqual(initial, emptyArtwork());
  assert.equal(one.scenes.length, 0);
  assert.equal(three.cast.length, 1);
  assert.equal(three.scenes.length, 1);
  assert.equal(three.cast[0].portrait_code, corrected.portrait_code);
  three.scenes[0].headline = { text: 'changed' };
  assert.deepEqual(two.scenes[0].headline, { text: 'เบลมาแล้ว' }, 'snapshots do not alias nested overlays');
});

test('rejects off-plan actors/scenes or invalid code while preserving the saved snapshot', () => {
  const state = updateArtwork(emptyArtwork(), 'draw_character', { character: character() }, plan);
  const original = structuredClone(state);
  assert.throws(() => updateArtwork(state, 'draw_character', { character: { ...character(), name: 'คนอื่น' } }, plan), /not in the storyboard/);
  assert.throws(() => updateArtwork(state, 'draw_scene', { scene: scene('foreign') }, plan), /not in the storyboard/);
  assert.throws(() => updateArtwork(state, 'draw_scene', { scene: scene('s1', 'def draw(c,t,p):\n    c.person("คนอื่น",540,700,200)') }, plan), /planned character/);
  assert.throws(() => updateArtwork(state, 'draw_scene', { scene: { ...scene('s1'), type: 'scenario' } }, plan));
  assert.throws(() => updateArtwork(state, 'draw_character', { character: { ...character(), portrait_code: 'bad' } }, plan));
  assert.throws(() => updateArtwork(state, 'save_art', { art: 'x'.repeat(9001) }, plan));
  assert.deepEqual(state, original);
});

test('completion requires every planned portrait and shot with no unrelated or duplicate entries', () => {
  let state = emptyArtwork();
  assert.equal(artworkComplete(state, plan), false);
  for (const shot of plan.shots) state = updateArtwork(state, 'draw_scene', { scene: scene(shot.seg) }, plan);
  assert.equal(artworkComplete(state, plan), false);
  state = updateArtwork(state, 'draw_character', { character: character() }, plan);
  assert.equal(artworkComplete(state, plan), true);
  assert.equal(artworkComplete({ ...state, scenes: [...state.scenes, state.scenes[0]] }, plan), false);
  assert.equal(artworkComplete({ ...state, cast: [...state.cast, { ...state.cast[0], name: 'คนอื่น' }] }, plan), false);
});

test('staged artwork overrides injected submit code and metadata-only submits assemble saved pieces', () => {
  let state = updateArtwork(emptyArtwork(), 'draw_character', { character: character() }, plan);
  state = updateArtwork(state, 'draw_scene', { scene: scene('s1') }, plan);
  state = updateArtwork(state, 'save_art', { art: 'def floor(c):\n    c.rect(0,1400,1080,520,"tan")' }, plan);
  const metadata = { title_th: 'เรื่องของเบล', cast: [{ name: 'เบล', portrait_code: 'injected' }], scenes: [{ seg: 's1', type: 'scenario', code: 'injected' }], art: 'injected' };
  const merged = mergeArtwork(metadata, state);
  assert.equal(merged.cast[0].portrait_code, state.cast[0].portrait_code);
  assert.equal(merged.scenes[0].code, state.scenes[0].code);
  assert.equal(merged.scenes[0].type, 'custom');
  assert.equal(merged.art, state.art);
  assert.equal(metadata.cast[0].portrait_code, 'injected');
  const assembled = mergeArtwork({ title_th: 'เรื่องของเบล' }, state);
  assert.deepEqual(assembled.cast, state.cast);
  assert.deepEqual(assembled.scenes, state.scenes);
  assert.equal(assembled.title_th, 'เรื่องของเบล');
});

test('whole episode submissions remain unchanged without staged work', () => {
  const input = { title_th: 'เรื่องของเบล', cast: [character()], scenes: plan.shots.map(s => scene(s.seg)), art: 'legacy helpers' };
  assert.deepEqual(mergeArtwork(input, emptyArtwork()), input);
});

test('empty shared-art replacement is deliberate and per-piece bounds limit response size', () => {
  let state = updateArtwork(emptyArtwork(), 'draw_character', { character: character() }, plan);
  assert.equal(mergeArtwork({ art: 'legacy helper' }, state).art, 'legacy helper');
  state = updateArtwork(state, 'save_art', { art: '' }, plan);
  assert.equal(mergeArtwork({ art: 'obsolete helper' }, state).art, '');
  assert.throws(() => updateArtwork(state, 'draw_character', { character: { ...character(), portrait_code: character().portrait_code + ' '.repeat(9000) } }, plan));
  assert.throws(() => updateArtwork(state, 'draw_scene', { scene: scene('s1', scene('s1').code + ' '.repeat(6000)) }, plan));
  const fivePeople = { ...plan, shots: plan.shots.map(s => ({ ...s, characters: ['a', 'b', 'c', 'd', 'e'] })) };
  let four = emptyArtwork();
  for (const name of ['a', 'b', 'c', 'd']) four = updateArtwork(four, 'draw_character', { character: { ...character(), name } }, fivePeople);
  assert.throws(() => updateArtwork(four, 'draw_character', { character: { ...character(), name: 'e' } }, fivePeople));
  assert.equal(four.cast.length, 4);
});

function finishedArtwork() {
  let state = updateArtwork(emptyArtwork(), 'draw_character', { character: character() }, plan);
  state = updateArtwork(state, 'save_art', { art: 'def floor(c):\n    c.rect(0,1400,1080,520,"tan")' }, plan);
  for (const shot of plan.shots) state = updateArtwork(state, 'draw_scene', { scene: scene(shot.seg) }, plan);
  return state;
}

test('notes-only replanning preserves every saved drawing and helper without aliasing', () => {
  const state = finishedArtwork();
  const next = reconcileArtwork(plan, { ...plan, character_notes: 'More detailed facial reference notes' }, state);
  assert.deepEqual(next, state);
  next.cast[0].portrait_description = 'edited';
  next.scenes[0].headline = { text: 'edited' };
  assert.equal(state.cast[0].portrait_description, 'Long face and dark hair');
  assert.deepEqual(state.scenes[0].headline, { text: 'เบลมาแล้ว' });
});

test('a revised shot or narration drops only the affected scene, retaining portraits and helpers', () => {
  const state = finishedArtwork();
  const visualPlan = { ...plan, shots: plan.shots.map(shot => shot.seg === 's2' ? { ...shot, camera: 'close up' } : shot) };
  const visual = reconcileArtwork(plan, visualPlan, state);
  assert.deepEqual(visual.scenes.map(shot => shot.seg), ['s1', 's3', 's4']);
  assert.deepEqual(visual.cast, state.cast);
  assert.equal(visual.art, state.art);
  assert.equal(visual.art_saved, true);
  const narrationPlan = { ...plan, script: plan.script.map(line => line.id === 's3' ? { ...line, text: 'บทเล่าที่เปลี่ยนใหม่' } : line) };
  assert.deepEqual(reconcileArtwork(plan, narrationPlan, state).scenes.map(shot => shot.seg), ['s1', 's2', 's4']);
  const beatPlan = { ...plan, script: plan.script.map(line => line.id === 's4' ? { ...line, beat: 'cta' as const } : line) };
  assert.deepEqual(reconcileArtwork(plan, beatPlan, state).scenes.map(shot => shot.seg), ['s1', 's2', 's3']);
});

test('a changed cast removes obsolete portraits and dependent scenes, while a new plan retains reusable helpers', () => {
  const state = finishedArtwork();
  const renamed = { ...plan, shots: plan.shots.map(shot => ({ ...shot, characters: ['นิก'] })) };
  const next = reconcileArtwork(plan, renamed, state);
  assert.deepEqual(next.cast, []);
  assert.deepEqual(next.scenes, []);
  assert.equal(next.art, state.art);
  const unknownPlan = reconcileArtwork(null, plan, state);
  assert.deepEqual(unknownPlan.scenes, []);
  assert.deepEqual(unknownPlan.cast, state.cast);
});
