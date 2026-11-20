// 執行：node --experimental-strip-types --test scripts/test_complaint_compliance.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBanned, checkNumbers, complianceCheck, DISCLAIMER } from '../lib/complaint/compliance.ts';

const facts = { fund: { m1: -5.23, ytd: 12.4 }, benches: [{ periods: { m1: -3.1 } }] };

test('禁語：保證、穩賺、即將反彈會被抓到', () => {
  const hits = scanBanned('我們保證您穩賺，市場即將反彈。');
  assert.equal(hits.length, 3);
});

test('禁語：警語內的「不保證」不誤報', () => {
  assert.deepEqual(scanBanned(`一般說明。\n\n${DISCLAIMER}`), []);
  assert.deepEqual(scanBanned('過去績效不保證未來收益'), []);
});

test('數字：事實包內的數字（含正負號）通過', () => {
  assert.deepEqual(checkNumbers('近一月 -5.23%，今年 +12.40%，大盤 −3.10%', facts), []);
});

test('數字：兩數之差（落後 2.13 個百分點）通過', () => {
  assert.deepEqual(checkNumbers('落後大盤 2.13 個百分點', facts), []);
});

test('數字：自編數字被標記', () => {
  const w = checkNumbers('預估明年可達 30.5%', facts);
  assert.equal(w.length, 1);
  assert.match(w[0], /30\.5%/);
});

test('complianceCheck 一定補上警語且不重複', () => {
  const once = complianceCheck('內容', facts).reply;
  assert.ok(once.includes('不保證基金之最低投資收益'));
  assert.equal(complianceCheck(once, facts).reply.split('【警語】').length, 2);
});
