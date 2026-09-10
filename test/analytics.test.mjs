import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv, createAliases, dateRange, estimateCost, hourlySeries, normalizePricing, selectRange, shiftDate, validateDateRange } from '../public/analytics.js';

const count = (input, output, cached = 0, reasoning = 0) => ({ input, cached, cacheWrite: 0, output, reasoning, total: input + output });
const bucket = (date, model, values, hour) => ({ date, ...(hour == null ? {} : { hour }), ...values, models: [{ model, ...values }] });
const rates = { alpha: { input: 2, cached: 0.5, output: 10 }, beta: { input: 1, cached: 0.25, output: 5 } };

test('date ranges use inclusive calendar dates across year, leap day, and DST boundaries', () => {
  assert.equal(shiftDate('2025-12-31', 1), '2026-01-01');
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
  assert.deepEqual(dateRange('2026-03-07', '2026-03-10'), ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  assert.deepEqual(dateRange('2026-09-10', '2026-09-10'), ['2026-09-10']);
  for (const [from, to] of [['2026-02-29', '2026-03-01'], ['2026-09-11', '2026-09-10'], ['bad', '2026-01-01'], ['2000-01-01', '2026-01-01']]) {
    assert.equal(validateDateRange(from, to), false);
    assert.deepEqual(dateRange(from, to), []);
  }
  assert.equal(shiftDate('2026-02-30', 1), null);
  assert.equal(shiftDate('2026-09-10', 0.5), null);
});

test('range selection counts daily increments once, aggregates per-model usage and fills empty dates', () => {
  const alpha = count(100, 10, 30, 5);
  const beta = count(200, 20, 50, 9);
  const sessions = [{ id: 'parent', ...count(9000, 900), days: [bucket('2026-09-08', 'alpha', count(1, 1)), bucket('2026-09-10', 'alpha', alpha), bucket('2026-09-11', 'beta', beta)] },
    { id: 'child', parentId: 'parent', ...count(6000, 600), days: [bucket('2026-09-11', 'alpha', alpha)] },
    { id: 'outside', ...count(100, 10), days: [bucket('2026-09-01', 'alpha', alpha)] }];
  const before = structuredClone(sessions);
  const selected = selectRange(sessions, '2026-09-09', '2026-09-11');
  assert.equal(selected.totals.total, 440);
  assert.equal(selected.totals.cached, 110);
  assert.equal(selected.totals.reasoning, 19);
  assert.equal(selected.sessions.length, 2);
  assert.equal(selected.sessions[0].total, 330);
  assert.equal(selected.days[0].total, 0);
  assert.equal(selected.days[2].total, 330);
  assert.deepEqual(selected.models.map(({ model, total }) => [model, total]), [['alpha', 220], ['beta', 220]]);
  assert.deepEqual(sessions, before);
  assert.equal(selectRange(sessions, 'bad', 'bad').sessions.length, 0);
});

test('hourly series respects stored local date buckets at midnight and returns stable 24 hours', () => {
  const sessions = [{ hours: [bucket('2026-09-09', 'alpha', count(7, 2), 23), bucket('2026-09-10', 'alpha', count(10, 3), 0), bucket('2026-09-10', 'alpha', count(5, 1), 23), bucket('2026-09-10', 'alpha', count(99, 99), 24)] },
    { hours: [bucket('2026-09-10', 'beta', count(20, 4), 0)] }];
  const hours = hourlySeries(sessions, '2026-09-10');
  assert.equal(hours.length, 24);
  assert.equal(hours[0].total, 37);
  assert.equal(hours[0].models.length, 2);
  assert.equal(hours[23].total, 6);
  assert.equal(hours[1].total, 0);
  assert.equal(hours.reduce((total, hour) => total + hour.total, 0), 43);
});

test('cost estimates price cached inputs separately and reasoning only within output across models', () => {
  const cost = estimateCost([{ model: 'alpha', ...count(1000000, 100000, 400000, 70000) }, { model: 'beta', ...count(1000000, 200000, 0, 50000) }], rates);
  assert.equal(cost.amount, 4.4);
  assert.equal(cost.pricedTokens, 2300000);
  assert.equal(cost.unpricedTokens, 0);
  assert.equal(cost.complete, true);
  const unusual = estimateCost([{ model: 'alpha', ...count(1000000, 0, 1500000) }], rates);
  assert.equal(unusual.amount, 0.75);
});

test('missing and invalid rates remain unpriced while explicitly configured zero is valid', () => {
  const models = [{ model: 'alpha', ...count(100, 10) }, { model: 'free', ...count(200, 20) }, { model: '', ...count(300, 30) }, { model: 'missing', ...count(400, 40) }];
  const result = estimateCost(models, { alpha: rates.alpha, free: { input: 0, cached: 0, output: 0 }, '': rates.beta });
  assert.equal(result.complete, false);
  assert.equal(result.pricedTokens, 330);
  assert.equal(result.unpricedTokens, 770);
  assert.deepEqual(result.missingModels, ['', 'missing']);
  for (const invalid of [{ input: 1, output: 1 }, { input: '', cached: 0, output: 1 }, { input: -1, cached: 0, output: 1 }, { input: Infinity, cached: 0, output: 1 }, { input: NaN, cached: 0, output: 1 }]) {
    assert.equal(estimateCost([models[0]], { alpha: invalid }).complete, false);
  }
  assert.equal(estimateCost([{ model: 'unknown', ...count(1, 1) }], { unknown: rates.alpha }).complete, false);
});

test('unattributed bucket usage stays unknown instead of inheriting the last session model', () => {
  const sessions = [{ id: 'one', model: 'alpha', days: [{ date: '2026-09-10', ...count(100, 10) }] }];
  const selected = selectRange(sessions, '2026-09-10', '2026-09-10');
  assert.deepEqual(selected.models.map(({ model, total }) => [model, total]), [['', 110]]);
  assert.equal(estimateCost(selected.models, rates).unpricedTokens, 110);
});

test('pricing normalization keeps independent currencies and drops unsafe or malformed rates', () => {
  const raw = JSON.parse('{"currency":"CNY","tables":{"USD":{"alpha":{"input":2,"cached":0.5,"output":10},"__proto__":{"input":1,"cached":1,"output":1},"bad":{"input":"1","cached":0,"output":1}},"CNY":{"alpha":{"input":0,"cached":0,"output":0},"constructor":{"input":1,"cached":1,"output":1}}}}');
  const normalized = normalizePricing(raw);
  assert.equal(normalized.currency, 'CNY');
  assert.deepEqual(normalized.tables.USD, { alpha: rates.alpha });
  assert.deepEqual(normalized.tables.CNY, { alpha: { input: 0, cached: 0, output: 0 } });
  assert.equal(Object.hasOwn(normalized.tables.USD, '__proto__'), false);
  assert.equal(normalizePricing({ currency: 'EUR' }).currency, 'USD');
  assert.deepEqual(normalizePricing(null), { currency: 'USD', tables: { USD: {}, CNY: {} } });
  assert.deepEqual(normalizePricing({ tables: { USD: [], CNY: { alpha: { input: 1, cached: 0, output: Infinity } } } }).tables, { USD: {}, CNY: {} });
});

test('aliases are deterministic across ordering and include parents absent from the dataset', () => {
  const sessions = [{ id: 'raw-b', parentId: 'missing-parent', cwd: 'D:\\private-b' }, { id: 'raw-a', cwd: 'D:\\private-a' }];
  const aliases = createAliases(sessions);
  const reordered = createAliases([...sessions].reverse());
  assert.equal(aliases.session('raw-b'), reordered.session('raw-b'));
  assert.equal(aliases.project('D:\\private-a'), reordered.project('D:\\private-a'));
  assert.match(aliases.session('missing-parent'), /^会话 \d{3}$/);
  assert.notEqual(aliases.session('missing-parent'), aliases.session('raw-a'));
});

test('private CSV omits raw IDs, missing parent ID, titles, and full or partial project paths', () => {
  const sessions = [{ id: 'raw-session-id', parentId: 'raw-parent-id', title: 'Sensitive task title', cwd: 'D:\\Users\\private-user\\secret-project', kind: 'subagent', ...count(100, 10), models: [{ model: 'alpha', ...count(100, 10) }], updatedAt: '2026-09-10T00:00:00Z' }];
  const csv = buildCsv(sessions, { privacy: true, aliases: createAliases(sessions), from: '2026-09-10', to: '2026-09-10', currency: 'CNY', rates });
  assert.equal(csv[0], '\uFEFF');
  for (const secret of ['raw-session-id', 'raw-parent-id', 'Sensitive task title', 'D:\\Users', 'private-user', 'secret-project']) assert.equal(csv.includes(secret), false, secret);
  assert.match(csv, /会话 001/);
  assert.match(csv, /项目 001/);
  assert.match(csv, /"CNY","完整"/);
  const normal = buildCsv(sessions, { rates });
  assert.match(normal, /raw-session-id/);
  assert.match(normal, /Sensitive task title/);
});

test('CSV neutralizes formula cells and quotes commas, quotes, and newlines', () => {
  const session = { id: '=HYPERLINK("bad")', title: ' \t+cmd', cwd: '@path', ...count(10, 1), models: [{ model: 'alpha', ...count(10, 1) }] };
  const csv = buildCsv([session], { rates });
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"' \t\+cmd"/);
  assert.match(csv, /"'@path"/);
  const quoted = buildCsv([{ ...session, title: 'hello,"there"\nnext' }], { rates });
  assert.ok(quoted.includes('"hello,""there""\nnext"'));
});

test('CSV leaves incomplete reference costs blank and exposes unpriced coverage', () => {
  const csv = buildCsv([{ id: 'a', ...count(100, 10), models: [{ model: 'missing', ...count(100, 10) }] }], { rates });
  assert.ok(csv.includes('"110","","USD","不完整","0","110"'));
  const free = buildCsv([{ id: 'b', ...count(100, 10), models: [{ model: 'free', ...count(100, 10) }] }], { rates: { free: { input: 0, cached: 0, output: 0 } } });
  assert.ok(free.includes('"110","0.00000000","USD","完整","110","0"'));
});
