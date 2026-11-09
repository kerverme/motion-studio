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

test('partial story revision changes only named fields and keeps omitted text, cues, shot order and metadata exact', async () => {
  const {reviseStoryboard}=await import('./storyboard.js');
  const original=plan(),snapshot=structuredClone(original);
  const next=reviseStoryboard(original,{segments:[{seg:'reveal',text:'เรื่องใหม่ที่ตรวจต้นฉบับแล้ว',visual:'A revised drawing grounded in the verified source'}]});
  assert.equal(next.script[2].text,'เรื่องใหม่ที่ตรวจต้นฉบับแล้ว');
  assert.equal(next.shots[2].visual,'A revised drawing grounded in the verified source');
  assert.equal(next.shots[2].action,original.shots[2].action);
  assert.equal(next.character_notes,original.character_notes);
  for(const i of [0,1,3]){assert.deepEqual(next.script[i],original.script[i]);assert.deepEqual(next.shots[i],original.shots[i]);}
  next.shots[0].characters[0]='edited';
  assert.deepEqual(original,snapshot,'new plan must not alias or mutate the saved plan');
});

test('partial story revision rejects unknown, duplicate, empty, structural and invalid cast edits without mutation', async () => {
  const {reviseStoryboard}=await import('./storyboard.js');
  const original=plan(),snapshot=structuredClone(original);
  for(const input of [
    {segments:[{seg:'unknown',text:'ไม่ใช่ฉากเดิม'}]},
    {segments:[{seg:'reveal',text:'แก้ครั้งแรก'},{seg:'reveal',text:'แก้อีกครั้ง'}]},
    {segments:[{seg:'reveal'}]},
    {segments:[]},
    {segments:[{seg:'reveal',id:'renamed',text:'เปลี่ยนชื่อฉาก'}]},
    {segments:[{seg:'reveal',characters:[]}]},
    {segments:[{seg:'reveal',characters:['เบล','เบล']}]},
    {segments:[{seg:'reveal',action:'x'.repeat(601)}]},
    {segments:[{seg:'reveal',text:'แก้บท'}],story_mode:'general'},
  ]){assert.throws(()=>reviseStoryboard(original,input));assert.deepEqual(original,snapshot);}
});


test('recurring cartoon mode requires one common presenter across every shot, not rotating unrelated cast',()=>{
  const recurring={...plan(),story_mode:'general' as const,recurring_character:true};
  assert.equal(Storyboard.safeParse(recurring).success,true);
  assert.equal(Storyboard.safeParse({...recurring,shots:[]}).success,false,'malformed empty plans must return validation errors');
  const empty=structuredClone(recurring);empty.shots[2].characters=[];
  assert.equal(Storyboard.safeParse(empty).success,false);
  const rotating=structuredClone(recurring);rotating.shots[2].characters=['คนอื่น'];
  assert.equal(Storyboard.safeParse(rotating).success,false);
  const supporting=structuredClone(recurring);supporting.shots[2].characters.push('เพื่อน');
  assert.equal(Storyboard.safeParse(supporting).success,true);
  const optional=structuredClone(empty);optional.recurring_character=false;
  assert.equal(Storyboard.safeParse(optional).success,true,'general stories without this rule still permit empty character shots');
});

test('recurring presenter must exist in cast and be drawn in every scene; draft cannot drop its policy',()=>{
  const d={...draft(),recurring_character:true};d.storyboard=Storyboard.parse({...d.storyboard,story_mode:'general',recurring_character:true});
  assert.deepEqual(validateStoryboardDraft(d.storyboard,d),[]);
  assert.ok(validateStoryboardDraft(d.storyboard,{...d,recurring_character:false}).some(e=>e.includes('recurring character setting')));
  const missing=structuredClone(d);missing.scenes[1].code='def draw(c,t,p):\n  c.text(10,10,"only an explanation")';
  assert.ok(validateStoryboardDraft(missing.storyboard,missing).some(e=>e.includes('draw "เบล"')));
  const noCast=structuredClone(d);noCast.cast=[];
  assert.ok(validateStoryboardDraft(noCast.storyboard,noCast).some(e=>e.includes('is not in cast')));
});

test('partial repair cannot remove the recurring presenter and leaves the previous plan intact',async()=>{
  const {reviseStoryboard}=await import('./storyboard.js');
  const p=Storyboard.parse({...plan(),story_mode:'general',recurring_character:true}),original=structuredClone(p);
  assert.throws(()=>reviseStoryboard(p,{segments:[{seg:'market',characters:[]}]}));
  assert.throws(()=>reviseStoryboard(p,{segments:[{seg:'market',characters:['อีกคน']}]}));
  assert.deepEqual(p,original);
  const revised=reviseStoryboard(p,{segments:[{seg:'market',text:'ตัวละครช่วยอธิบายด้วยถ้อยคำง่าย ๆ'}]});
  assert.equal(revised.recurring_character,true);assert.deepEqual(revised.shots,p.shots);
});

test('generic mascot cat calls cannot stand in for a named recurring cat presenter',()=>{
  const p=Storyboard.parse({...plan(),story_mode:'general',recurring_character:true,shots:plan().shots.map(shot=>({...shot,characters:['น้องส้ม']}))});
  const scenes=p.shots.map(shot=>({seg:shot.seg,type:'custom',code:'def draw(c,t,p):\n  c.cat(400,900,240)'}));
  const errors=validateStoryboardDraft(p,{storyboard:p,recurring_character:true,script:p.script,cast:[{name:'น้องส้ม'}],scenes});
  assert.equal(errors.filter(error=>error.includes('draw "น้องส้ม" with a direct c.person')).length,p.shots.length);
  const named=scenes.map(scene=>({...scene,code:'def draw(c,t,p):\n  c.person("น้องส้ม",400,900,240)'}));
  assert.deepEqual(validateStoryboardDraft(p,{storyboard:p,recurring_character:true,script:p.script,cast:[{name:'น้องส้ม'}],scenes:named}),[]);
});
