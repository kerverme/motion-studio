import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ecbUsdToThb} from './video-fx.js';
const sample="<Cube><Cube time='2026-11-24'><Cube currency='USD' rate='1.0963'/><Cube currency='THB' rate='37.197'/></Cube></Cube>";
test('ECB reference uses the EUR cross rate, validates its date and refuses bad or duplicated values',()=>{
  const today=Date.parse('2026-11-24T16:00:00Z');
  const r=ecbUsdToThb(sample,today);
  assert.equal(r.rate,Number((37.197/1.0963).toFixed(6)));assert.equal(r.date,'2026-11-24');
  assert.throws(()=>ecbUsdToThb(sample,today+8*86400000));
  assert.throws(()=>ecbUsdToThb(sample.replace('1.0963','0'),today));
  assert.throws(()=>ecbUsdToThb(sample.replace('THB','USD'),today));
});
