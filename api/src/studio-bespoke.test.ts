import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Draft, checkDraft, applyCast, buildPackage } from './studio.js';
import { Storyboard } from './storyboard.js';

const portrait = 'def draw(c,t,p):\n  c.ellipse(0,0,80,110,"tan")\n  c.circle(-25,-20,5,"black")\n  c.circle(25,-20,5,"black")';
function specimen() {
  const script = [
    { id: 'open', beat: 'hook', text: 'คนชื่อ เบล ในประเทศไทย มีกี่คน' },
    ...['market', 'glasses', 'monkey', 'reveal'].map(id => ({ id, beat: 'rehook', text: 'แต่เดี๋ยวก่อน เรื่องของเบลยังไม่จบ เราจะตามไปดูที่ตลาด เมื่อแว่นหายไปแล้วใครกันที่เก็บได้ ลองสังเกตคนรอบตัวให้ดี เพราะคำตอบอาจอยู่ใกล้กว่าที่คิด' })),
    { id: 'end', beat: 'cta', text: 'ถ้าคุณเป็นเบล จะเริ่มตามหาจากตรงไหน ลองเล่าในคอมเมนต์ให้ฟังหน่อย' },
  ];
  const storyboard = Storyboard.parse({ script,
    shots: script.map(s => ({ seg: s.id, visual: 'A new market scene composed around the missing glasses', action: 'Bell turns to follow the monkey', camera: 'Medium shot with a slow pan', characters: ['เบล'] })),
    character_notes: 'Bell has a long face and narrow nose with a distinctive hairline.',
  });
  return Draft.parse({ title_th: 'แว่นของเบลหายไปไหน', angle: 'ตามหาแว่นที่ตลาด', format: 'mystery', storyboard,
    script, scenes: script.map(s => ({ seg: s.id, type: 'custom', code: 'def draw(c,t,p):\n  c.grad("sky","cream")\n  c.person("เบล",450,700,250)' })),
    art: 'def ground(c):\n  c.rect(0,1200,1080,720,"cream")',
    cast: [{ name: 'เบล', portrait_code: portrait, portrait_description: 'A long face and narrow nose.' }],
    sources: [{ url: 'https://example.org/research', publisher: 'Example', published: String(new Date().getUTCFullYear()), claim: 'ไม่มีข้อมูลจำนวนคนชื่อเบล', confidence: 'low' }],
    claims: [{ text: 'เบลเป็นชื่อของตัวละครสมมติ', kind: 'assumption', source_ids: [] }],
    captions: { facebook: 'เบล', instagram: 'เบล', tiktok: 'เบล', youtube: 'เบล', twitter: 'เบล' },
  });
}

test('full draft schema retains storyboard and bespoke face/body code', () => {
  const d = specimen();
  assert.equal(d.cast[0].portrait_code, portrait);
  assert.equal(d.storyboard?.shots.length, 6);
  assert.equal(d.scenes[0].code?.includes('c.person'), true);
});

test('six custom shots pass without template cap, forced scenario or repeated-type rejection', () => {
  const d = specimen();
  const previous = [{ title: 'Previous drawing', types: d.scenes.map(s => s.type), format: 'skit', style: 'classic', music: 'playful' }];
  const result = checkDraft(d, null, previous, { bespoke: true, requiredNames: ['เบล'] });
  assert.deepEqual(result.problems, []);
});

test('reference colors are retained while newly drawn facial geometry survives applyCast', () => {
  const d = specimen();
  d.cast[0].backdrop = 'data:image/jpeg;base64,injected';
  d.cast.push({ name: 'เพื่อน', portrait_code: portrait, backdrop: 'data:image/jpeg;base64,invented' });
  const source = { name: 'เบล', look: { hairstyle: 'short', hair_color: [20, 25, 30], skin: [200, 150, 120],
    top: 'shirt', top_color: [5, 70, 160], bottom: 'pants', bottom_color: [10, 10, 10], glasses: 'none', accessories: [], accessory_color: [0, 0, 0], backdrop: 'data:image/jpeg;base64,legacy' } };
  const result = applyCast(d, [source]);
  assert.equal(result.cast[0].portrait_code, portrait);
  assert.equal(result.cast[0].portrait_description, d.cast[0].portrait_description);
  assert.deepEqual(result.cast[0].skin, source.look.skin);
  assert.equal(result.cast[0].backdrop, undefined);
  assert.equal(result.cast[1].backdrop, undefined);
  assert.ok(applyCast(d, []).cast.every(c => c.backdrop === undefined));
  const legacy = { ...d, storyboard: undefined };
  assert.equal(applyCast(legacy, [source]).cast[0].backdrop, source.look.backdrop);
});

test('legacy schema and validation do not require storyboard or bespoke portraits', () => {
  const raw = specimen();
  delete raw.storyboard; delete raw.cast[0].portrait_code;
  const d = Draft.parse(raw);
  const problems = checkDraft(d, null).problems;
  assert.equal(d.storyboard, undefined);
  assert.equal(problems.some(p => /plan_story|storyboard|portrait_code/.test(p)), false);
});

test('new generation rejects missing plan, missing portrait, and off-plan narration', () => {
  const d = specimen();
  delete d.storyboard;
  assert.ok(checkDraft(d, null, [], { bespoke: true }).problems.includes('Call plan_story before drawing the episode'));
  const withoutPortrait = specimen(); delete withoutPortrait.cast[0].portrait_code;
  assert.ok(checkDraft(withoutPortrait, null).problems.some(p => p.includes('portrait_code')));
  const changed = specimen(); changed.script[1].text = 'บทเปลี่ยนไปโดยไม่ได้วางแผนใหม่';
  assert.ok(checkDraft(changed, null).problems.some(p => p.startsWith('script must match')));
});

test('reference character must appear in at least one third of custom shots', () => {
  const d = specimen();
  d.cast.push({ name: 'เพื่อน', portrait_code: portrait });
  for (let i = 1; i < d.scenes.length; i++) {
    d.scenes[i].code = 'def draw(c,t,p):\n  c.grad("sky","cream")\n  c.person("เพื่อน",450,700,250)';
    d.storyboard!.shots[i].characters = ['เพื่อน'];
  }
  assert.ok(checkDraft(d, null, [], { requiredNames: ['เบล'] }).problems.some(p => p.includes('at least a third')));
});

test('episode assembly carries portraits and custom shot code to the renderer', () => {
  const d = specimen();
  const pkg = buildPackage('เรื่องเบล', d, []);
  const encoded = pkg.scene_code.match(/SPEC = json\.loads\((.*)\)\nSCENES/);
  assert.ok(encoded);
  const spec = JSON.parse(JSON.parse(encoded[1]));
  assert.equal(spec.cast[0].portrait_code, portrait);
  assert.deepEqual(spec.scenes, d.scenes);
  assert.equal(pkg.storyboard[0].visual, d.storyboard!.shots[0].visual);
  assert.equal(pkg.storyboard[0].camera, d.storyboard!.shots[0].camera);
  assert.equal(pkg.storyboard[0].action, d.storyboard!.shots[0].action);
  assert.deepEqual(pkg.storyboard[0].characters, ['เบล']);
  assert.equal(pkg.cover?.who, 'เบล');
  assert.equal(pkg.scene_code.includes('reference_image'), false);
});
