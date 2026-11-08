import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storyboard, personCalls, validateStoryboardDraft } from './storyboard.js';

const plan = () => Storyboard.parse({
  script: ['opening', 'market', 'reveal', 'end'].map((id, i) => ({ id, text: `เล่าเรื่องของเบล ฉากที่ ${i}`, beat: i === 0 ? 'hook' : i === 3 ? 'cta' : 'info' })),
  shots: ['opening', 'market', 'reveal', 'end'].map(seg => ({ seg, visual: 'A fresh drawing of a market in Lopburi', action: 'Bell reaches for her glasses', camera: 'Close view of face and hand', characters: ['เบล'] })),
  character_notes: 'Keep the same jaw, nose and hair silhouette in every shot.',
});
const draft = () => {
  const storyboard = plan();
  return { storyboard, script: structuredClone(storyboard.script), cast: [{ name: 'เบล' }],
    scenes: storyboard.shots.map(s => ({ seg: s.seg, type: 'custom', code: 'def draw(c, t, p):\n  c.person("เบล", 450, 700, 250)\n' })) };
};

test('accepts all-custom narrative including its opening and more than two scenes', () => {
  const d = draft();
  assert.deepEqual(validateStoryboardDraft(d.storyboard, d), []);
});

test('plan enforces unique complete ordered mapping with bounded strings', () => {
  const p = plan();
  p.shots[1].seg = p.shots[0].seg;
  assert.equal(Storyboard.safeParse(p).success, false);
  const q = plan(); q.script[1].id = q.script[0].id;
  assert.equal(Storyboard.safeParse(q).success, false);
  const r = plan(); r.shots.reverse();
  assert.equal(Storyboard.safeParse(r).success, false);
  const s = plan(); s.shots[0].characters.push('เบล');
  assert.equal(Storyboard.safeParse(s).success, false);
  const t = plan(); t.shots[0].visual = 'x'.repeat(1201);
  assert.equal(Storyboard.safeParse(t).success, false);
  const u = plan(); u.shots[0].characters = [];
  assert.equal(Storyboard.safeParse(u).success, false);
});

test('art cannot silently change narration, beats, or planned story', () => {
  const p = plan(), d = draft();
  d.script[1].text += ' changed'; d.script[2].beat = 'payoff';
  d.storyboard.shots[1].visual = 'A completely different background and subject';
  const errors = validateStoryboardDraft(p, d);
  assert.ok(errors.some(e => e.startsWith('script must match')));
  assert.ok(errors.some(e => e.startsWith('storyboard must match')));
});

test('rejects legacy template substitution and duplicate or foreign scenes', () => {
  const d = draft(); d.scenes[0].type = 'scenario'; d.scenes.push({ ...d.scenes[0] });
  d.scenes[2].seg = 'foreign';
  const errors = validateStoryboardDraft(d.storyboard, d);
  assert.ok(errors.some(e => e.includes('every scene must be custom')));
  assert.ok(errors.some(e => e.includes('exactly one')));
  assert.ok(errors.some(e => e.includes('missing scene')));
  assert.ok(errors.some(e => e.includes('not in storyboard')));
});

test('requires named cast on-screen and rejects invented references', () => {
  const d = draft(); d.scenes[0].code = 'def draw(c,t,p):\n  c.person("Unknown", 0, 0)';
  d.cast = [];
  const errors = validateStoryboardDraft(d.storyboard, d);
  assert.ok(errors.some(e => e.includes('is not in cast')));
  assert.ok(errors.some(e => e.includes('draw "เบล"')));
  assert.ok(errors.some(e => e.includes('unknown cast member "Unknown"')));
});

test('comments, docstrings and labels cannot pretend a person was drawn', () => {
  const code = `# c.person("fake", 0, 0)\n"""c.person('doc', 0, 0)"""\nc.text(0, 0, 'c.person("label", 0, 0)')\nc.person("เบล", 0, 0)\nc.person('จริง', 0, 0)\nc.person(name, 0, 0)`;
  assert.deepEqual(personCalls(code), ['เบล', 'จริง']);
  const d = draft(); d.scenes[0].code = '# c.person("เบล", 0, 0)';
  assert.ok(validateStoryboardDraft(d.storyboard, d).some(e => e.includes('draw "เบล"')));
});

test('decoded Unicode names match cast and JSON property order is immaterial', () => {
  assert.deepEqual(personCalls('c.person("\\u0e40\\u0e1a\\u0e25", 0, 0)'), ['เบล']);
  const d = draft();
  const swapped = { character_notes: d.storyboard.character_notes, shots: d.storyboard.shots, script: d.storyboard.script };
  assert.deepEqual(validateStoryboardDraft(d.storyboard, { ...d, storyboard: swapped }), []);
});
