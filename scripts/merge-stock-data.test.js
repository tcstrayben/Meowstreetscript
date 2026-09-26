'use strict';
// Run with:  node --test scripts/
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, hashVoter, extractPayload, validate, merge, processSubmission, formatStore, PERIOD_MS } = require('./merge-stock-data.js');

const NOW = Date.UTC(2026, 8, 26, 20, 0, 0); // fixed "now" so the tests are repeatable
const unit = Math.round(NOW / PERIOD_MS); // the current 15-minute period number

const freshStore = () => ({
  format: 1, periodMinutes: 15, updated: null,
  stocks: { nine: { name: 'Nine Lives Insurance', prices: {} }, tide: { name: 'Tideworks Marine', prices: {} } },
});
const submission = (stocks) => '```json\n' + JSON.stringify({ format: 1, script: '0.10.0', stocks }) + '\n```';
const series = (start, prices) => Object.fromEntries(prices.map((p, i) => [String(start + i), p]));

test('a valid submission adds periods with one vote each', () => {
  const store = freshStore(), voters = {};
  const body = submission({ nine: { prices: series(unit - 5, [200, 201, 202, 201, 200]) } });
  const out = processSubmission({ body, login: 'alice', nowMs: NOW, store, voters });
  assert.equal(out.changed, true);
  assert.deepEqual(store.stocks.nine.prices[String(unit - 5)], [200, 1]);
  assert.equal(Object.keys(store.stocks.nine.prices).length, 5);
  assert.ok(out.message.includes('New price periods added: **5**'));
});

test('the same contributor cannot vote twice on a period', () => {
  const store = freshStore(), voters = {};
  const body = submission({ nine: { prices: series(unit - 3, [200, 201, 202]) } });
  processSubmission({ body, login: 'alice', nowMs: NOW, store, voters });
  const again = processSubmission({ body, login: 'Alice', nowMs: NOW, store, voters }); // different letter case, same person
  assert.equal(again.changed, false);
  assert.equal(store.stocks.nine.prices[String(unit - 3)][1], 1);
  assert.ok(again.message.includes('already contributed'));
});

test('a second contributor with the same price raises the confirmations', () => {
  const store = freshStore(), voters = {};
  const body = submission({ nine: { prices: series(unit - 3, [200, 201, 202]) } });
  processSubmission({ body, login: 'alice', nowMs: NOW, store, voters });
  processSubmission({ body, login: 'bob', nowMs: NOW, store, voters });
  assert.deepEqual(store.stocks.nine.prices[String(unit - 3)], [200, 2]);
});

test('conflicting prices: the majority wins, and it can flip', () => {
  const store = freshStore(), voters = {};
  const mk = (price) => submission({ nine: { prices: { [String(unit - 2)]: price } } });
  processSubmission({ body: mk(200), login: 'alice', nowMs: NOW, store, voters });
  processSubmission({ body: mk(203), login: 'bob', nowMs: NOW, store, voters });
  assert.equal(store.stocks.nine.prices[String(unit - 2)][0], 200); // 1 vs 1: the earlier one stays
  processSubmission({ body: mk(203), login: 'carol', nowMs: NOW, store, voters });
  const entry = store.stocks.nine.prices[String(unit - 2)];
  assert.equal(entry[0], 203); // 203 now has 2 votes against 1
  assert.equal(entry[1], 2);
  assert.deepEqual(entry[2], { 200: 1 });
});

test('unknown stock ids are rejected, and dangerous key names do nothing', () => {
  const store = freshStore(), voters = {};
  const body = '```json\n{"format":1,"stocks":{"evil":{"prices":{"1":5}},"__proto__":{"prices":{"1":5}},"constructor":{"prices":{"1":5}}}}\n```';
  const out = processSubmission({ body, login: 'mallory', nowMs: NOW, store, voters });
  assert.equal(out.changed, false);
  assert.deepEqual(Object.keys(store.stocks).sort(), ['nine', 'tide']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(voters).length, 0);
});

test('periods outside the accepted window are rejected', () => {
  const store = freshStore();
  const old = unit - LIMITS.maxAgeDays * 96 - 10;
  const future = unit + 50;
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices: { [old]: 200, [future]: 200, [unit - 1]: 200 } } } }, store, NOW);
  assert.deepEqual(Object.keys(accepted.nine), [String(unit - 1)]);
  assert.equal(rejected.length, 2);
});

test('prices that are not sane whole numbers are rejected', () => {
  const store = freshStore();
  const prices = { [unit - 1]: 1.5, [unit - 2]: -4, [unit - 3]: 0, [unit - 4]: '200', [unit - 5]: 999999999, [unit - 6]: null, [unit - 7]: 200 };
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices } } }, store, NOW);
  assert.deepEqual(Object.keys(accepted.nine), [String(unit - 7)]);
  assert.equal(rejected.length, 6);
});

test('bad period keys are rejected', () => {
  const store = freshStore();
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices: { abc: 200, '-5': 200, '1e9': 200, '12.5': 200 } } } }, store, NOW);
  assert.equal(Object.keys(accepted).length, 0);
  assert.equal(rejected.length, 4);
});

test('a price that jumps far from its neighbours is thrown out', () => {
  const store = freshStore();
  store.stocks.nine.prices[String(unit - 3)] = [200, 3];
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices: { [unit - 2]: 500, [unit - 4]: 201 } } } }, store, NOW);
  assert.deepEqual(Object.keys(accepted.nine), [String(unit - 4)]);
  assert.equal(rejected.length, 1);
});

test('with no stored price nearby, a price far from the recent level is thrown out', () => {
  const store = freshStore();
  for (let i = 0; i < 30; i++) store.stocks.nine.prices[String(unit - 300 - i)] = [200, 1]; // stored data is more than a day old
  const { accepted } = validate({ format: 1, stocks: { nine: { prices: { [unit - 2]: 90, [unit - 1]: 210 } } } }, store, NOW);
  assert.deepEqual(Object.keys(accepted.nine), [String(unit - 1)]);
});

test('a bad price next to a good one cannot get the good one rejected', () => {
  const store = freshStore();
  for (let i = 0; i < 30; i++) store.stocks.nine.prices[String(unit - 300 - i)] = [200, 1];
  // 999 is nonsense, 205 is fine, and they sit in consecutive periods
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices: { [unit - 5]: 999, [unit - 4]: 205 } } } }, store, NOW);
  assert.deepEqual(Object.keys(accepted.nine), [String(unit - 4)]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].period, unit - 5);
});

test('a lone spike between two agreeing prices is thrown out', () => {
  const store = freshStore(); // empty: no stored references at all
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices: { [unit - 3]: 200, [unit - 2]: 400, [unit - 1]: 201 } } } }, store, NOW);
  assert.deepEqual(Object.keys(accepted.nine).sort(), [String(unit - 3), String(unit - 1)].sort());
  assert.equal(rejected[0].reason, 'lone spike between two agreeing prices');
});

test('honest drift is accepted: a stock that has moved a lot is still believed next to stored prices', () => {
  const store = freshStore();
  for (let i = 0; i < 30; i++) store.stocks.nine.prices[String(unit - 20 - i)] = [200 + Math.round(i / 3), 1];
  // the stock has since climbed to about 250 in small steps: each step is close to the one before it
  const step = {};
  let price = 210;
  for (let i = 19; i >= 1; i--) { step[String(unit - i)] = price; price = Math.round(price * 1.02); }
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices: step } } }, store, NOW);
  assert.equal(rejected.length, 0);
  assert.equal(Object.keys(accepted.nine).length, 19);
});

test('bad input never changes anything and always explains itself', () => {
  const cases = ['', '   ', 'hello', '```json\n{not json\n```', '{"format":2,"stocks":{}}', '{"format":1}', '{"format":1,"stocks":[]}', '[]', 'x'.repeat(LIMITS.maxBodyChars + 1)];
  for (const body of cases) {
    const store = freshStore(), voters = {};
    const before = JSON.stringify(store);
    const out = processSubmission({ body, login: 'someone', nowMs: NOW, store, voters });
    assert.equal(out.changed, false, `case: ${body.slice(0, 20)}`);
    assert.equal(JSON.stringify(store), before);
    assert.ok(out.message.includes('nothing was added'));
  }
});

test('too many periods for one stock are rejected', () => {
  const store = freshStore();
  const prices = {};
  for (let i = 0; i < LIMITS.maxPeriodsPerStock + 1; i++) prices[String(unit - 5000 + i)] = 200;
  const { accepted, rejected } = validate({ format: 1, stocks: { nine: { prices } } }, store, NOW);
  assert.equal(Object.keys(accepted).length, 0);
  assert.equal(rejected[0].reason.startsWith('too many periods'), true);
});

test('extractPayload reads a fenced block, or JSON with chatter around it', () => {
  assert.equal(extractPayload('```json\n{"format":1,"stocks":{}}\n```').format, 1);
  assert.equal(extractPayload('Here you go:\n{"format":1,"stocks":{}}\nthanks!').format, 1);
  assert.equal(extractPayload('Paste ...\n\n```json\n{"format":1,"stocks":{}}\n```\n').format, 1);
});

test('old votes are cleaned up', () => {
  const store = freshStore();
  const oldPeriod = String(unit - LIMITS.maxAgeDays * 96 - 100);
  const voters = { [oldPeriod]: ['abc'], [String(unit - 1)]: ['def'] };
  merge(store, voters, { nine: { [String(unit - 2)]: 200 } }, 'zzz', NOW);
  assert.equal(voters[oldPeriod], undefined);
  assert.deepEqual(voters[String(unit - 1)], ['def']);
});

test('votes are counted once per period across stocks', () => {
  const store = freshStore(), voters = {};
  const body = submission({ nine: { prices: series(unit - 2, [200, 201]) }, tide: { prices: series(unit - 2, [100, 101]) } });
  processSubmission({ body, login: 'alice', nowMs: NOW, store, voters });
  assert.deepEqual(voters[String(unit - 2)], [hashVoter('alice')]);
  assert.equal(store.stocks.nine.prices[String(unit - 2)][1], 1);
  assert.equal(store.stocks.tide.prices[String(unit - 2)][1], 1);
});

test('the data file is written one price per line and reads back identically', () => {
  const store = freshStore();
  store.updated = '2026-09-26T20:00:00.000Z';
  store.stocks.nine.prices = { 5: [200, 2], 3: [199, 1, { 198: 1 }] };
  const text = formatStore(store);
  const back = JSON.parse(text);
  assert.deepEqual(back.stocks.nine.prices, { 3: [199, 1, { 198: 1 }], 5: [200, 2] });
  assert.ok(text.split('\n').length > 10);
  assert.equal(back.updated, store.updated);
});

test('hashing does not expose the login and ignores letter case', () => {
  assert.equal(hashVoter('Alice'), hashVoter('alice'));
  assert.notEqual(hashVoter('alice'), 'alice');
  assert.equal(hashVoter('alice').length, 10);
});
