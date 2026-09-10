import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COUNTERS, JsonlAccumulator, buildSnapshot, localDate, UsageStore } from '../usage.mjs';

const usage = (input, output = 10, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 2, total_tokens: input + output });
const meta = (id, extra = {}) => ({ type: 'session_meta', timestamp: '2026-09-10T01:00:00Z', payload: { id, originator: 'Codex Desktop', timestamp: '2026-09-10T01:00:00Z', ...extra } });
const event = (timestamp, total, last = total) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const parser = rows => { const result = new JsonlAccumulator(); result.feed(rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return result; };
const snapshot = records => buildSnapshot(records, { now: new Date('2026-09-10T08:00:00Z') });
const context = (model, timestamp = '2026-09-10T01:59:00Z') => ({ type: 'turn_context', timestamp, payload: { model } });

function assertModelSums(result) {
  const buckets = [{ ...result.totals, models: result.models }, ...result.days, ...result.sessions,
    ...result.sessions.flatMap(session => [...session.days, ...session.hours])];
  for (const bucket of buckets) {
    for (const key of COUNTERS) assert.equal(bucket.models.reduce((sum, model) => sum + model[key], 0), bucket[key], `${bucket.date || bucket.id || 'total'} ${key}`);
  }
}

test('uses cumulative deltas and merges copies without repeating cached or reasoning subsets', () => {
  const rows = [meta('desktop'), event('2026-09-10T02:00:00Z', usage(100, 10, 50)), event('2026-09-10T02:01:00Z', usage(100, 10, 50)), event('2026-09-10T02:02:00Z', usage(250, 30, 80), usage(150, 20, 30))];
  const result = snapshot([parser(rows), parser(rows.slice(0, 2))]);
  assert.equal(result.totals.total, 280);
  assert.equal(result.totals.cached, 80);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].files, 2);
});

test('counter reset counts known last request and does not invent missing reset usage', () => {
  const result = snapshot([parser([meta('desktop'), event('2026-09-10T02:00:00Z', usage(100, 10)), event('2026-09-10T02:01:00Z', usage(30, 3)), event('2026-09-10T02:02:00Z', usage(5, 1), null), event('2026-09-10T02:03:00Z', usage(15, 4), usage(10, 3))])]);
  assert.equal(result.totals.total, 156);
  assert.equal(result.coverage.resets, 2);
  assert.equal(result.coverage.warnings.length, 1);
});

test('assigns increments to event local day across midnight', () => {
  const first = new Date(2026, 8, 9, 23, 59, 0).toISOString();
  const second = new Date(2026, 8, 10, 0, 1, 0).toISOString();
  const result = buildSnapshot([parser([meta('desktop'), event(first, usage(100, 10)), event(second, usage(250, 30), usage(150, 20))])], { now: new Date(2026, 8, 10, 12) });
  assert.equal(result.today.total, 170);
  assert.equal(result.days.find(day => day.date === localDate(first)).total, 110);
  assert.equal(result.totals.total, 280);
});

test('attributes each request to its event model when a session changes models', () => {
  const result = snapshot([parser([
    meta('desktop'), context('model-a'),
    event('2026-09-10T02:00:00Z', usage(100, 10, 40)),
    context('model-b', '2026-09-10T02:01:00Z'),
    event('2026-09-10T02:02:00Z', { ...usage(300, 40, 140), reasoning_output_tokens: 5 }, { ...usage(200, 30, 100), reasoning_output_tokens: 3 }),
  ])]);
  assert.deepEqual(result.models.map(({ model, total }) => [model, total]), [['model-a', 110], ['model-b', 230]]);
  assert.equal(result.sessions[0].model, 'model-b');
  assert.equal(result.models.find(model => model.model === 'model-b').cached, 100);
  assertModelSums(result);
});

test('keeps early unknown calls and missing cumulative increments out of the latest model', () => {
  const result = snapshot([parser([
    meta('desktop'),
    event('2026-09-10T02:00:00Z', usage(1000, 100, 300), usage(100, 10, 30)),
    context('model-a', '2026-09-10T02:01:00Z'),
    event('2026-09-10T02:02:00Z', { ...usage(1500, 150, 500), reasoning_output_tokens: 10 }, { ...usage(200, 20, 80), reasoning_output_tokens: 3 }),
    context('model-b', '2026-09-10T02:03:00Z'),
  ])]);
  assert.deepEqual(result.models.map(({ model, total }) => [model, total]), [['', 1430], ['model-a', 220]]);
  assert.equal(result.models.find(model => model.model === 'model-a').cached, 80);
  assert.equal(result.sessions[0].model, 'model-b');
  assertModelSums(result);
});

test('uses metadata model fallback only for known request usage in the first cumulative snapshot', () => {
  const result = snapshot([parser([
    meta('desktop', { model: 'metadata-model' }),
    event('2026-09-10T02:00:00Z', usage(1000, 100, 300), usage(200, 20, 80)),
    event('2026-09-10T02:01:00Z', usage(1500, 150, 500), null),
  ])]);
  assert.deepEqual(result.models.map(({ model, total }) => [model, total]), [['', 1430], ['metadata-model', 220]]);
  assertModelSums(result);
});

test('retains full history and groups hours by the same local timezone as dates', () => {
  const first = new Date(2026, 3, 9, 23, 59).toISOString();
  const second = new Date(2026, 3, 10, 0, 1).toISOString();
  const third = new Date(2026, 3, 10, 1, 0).toISOString();
  const result = buildSnapshot([parser([
    meta('desktop'), context('model-a', first), event(first, usage(100, 10)),
    event(second, usage(250, 30), usage(150, 20)),
    event(third, usage(300, 35), usage(50, 5)),
  ])], { now: new Date(2026, 8, 10, 12) });
  assert.equal(result.days.find(day => day.date === '2026-04-09').total, 110);
  assert.equal(result.days.find(day => day.date === '2026-04-10').total, 225);
  assert.deepEqual(result.sessions[0].hours.map(({ date, hour, total }) => [date, hour, total]), [
    ['2026-04-09', 23, 110], ['2026-04-10', 0, 170], ['2026-04-10', 1, 55],
  ]);
  assert.equal(result.coverage.firstDate, '2026-04-09');
  assert.equal(result.coverage.lastDate, '2026-04-10');
  assert.equal(result.today.total, 0);
  assertModelSums(result);
});

test('archive copies enrich unknown event models without counting the event twice in either scan order', () => {
  const request = event('2026-09-10T02:00:00Z', usage(100, 10, 30));
  const unknown = parser([meta('desktop'), request]);
  const known = parser([meta('desktop'), context('model-a'), request]);
  for (const records of [[unknown, known], [known, unknown]]) {
    const result = snapshot(records);
    assert.equal(result.totals.total, 110);
    assert.deepEqual(result.models.map(({ model, total }) => [model, total]), [['model-a', 110]]);
    assert.equal(result.sessions[0].files, 2);
    assertModelSums(result);
  }
});

test('empty coverage uses today without implying observed history', () => {
  const result = snapshot([]);
  assert.equal(result.coverage.firstDate, result.todayDate);
  assert.equal(result.coverage.lastDate, result.todayDate);
  assert.deepEqual(result.models, []);
  assertModelSums(result);
});

test('child identity comes from first metadata and inherited parent usage is excluded', () => {
  const inherited = event('2026-09-10T02:00:00Z', usage(100, 10));
  const childMeta = meta('child', { session_id: 'parent', parent_thread_id: 'parent', forked_from_id: 'parent', timestamp: '2026-09-10T03:00:00Z', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } });
  const result = snapshot([parser([meta('parent'), inherited]), parser([childMeta, meta('parent'), inherited, event('2026-09-10T03:01:00Z', usage(150, 15), usage(50, 5)), event('2026-09-10T03:02:00Z', usage(180, 18), usage(30, 3))])]);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions.find(session => session.id === 'child').total, 88);
  assert.equal(result.totals.total, 198);
  assert.equal(result.coverage.inheritedEvents, 1);
});

test('fresh fork request larger than inherited counters is counted in full', () => {
  const inherited = event('2026-09-10T02:00:00Z', usage(100, 10));
  const childMeta = meta('child', { parent_thread_id: 'parent', forked_from_id: 'parent', timestamp: '2026-09-10T03:00:00Z', thread_source: 'subagent' });
  const result = snapshot([parser([meta('parent'), inherited]), parser([childMeta, inherited, event('2026-09-10T03:01:00Z', usage(150, 15))])]);
  assert.equal(result.totals.total, 275);
});

test('includes descendants of desktop sessions but excludes unrelated CLI sessions', () => {
  const rows = [parser([meta('desktop'), event('2026-09-10T02:00:00Z', usage(100))]), parser([meta('child', { originator: 'codex_cli_rs', parent_thread_id: 'desktop', thread_source: 'subagent' }), event('2026-09-10T02:00:00Z', usage(30))]), parser([meta('cli', { originator: 'codex_cli_rs' }), event('2026-09-10T02:00:00Z', usage(999))])];
  const result = snapshot(rows);
  assert.equal(result.totals.total, 150);
  assert.equal(result.coverage.excludedSessions, 1);
});

test('ignores null info and waits for full appended UTF-8 JSONL records', () => {
  const result = new JsonlAccumulator();
  const metadataBytes = Buffer.from(JSON.stringify(meta('desktop', { cwd: 'C:/projects/\u4e2d\u6587' })) + '\n');
  const unicodeOffset = metadataBytes.indexOf(Buffer.from('\u4e2d'));
  result.feed(metadataBytes.subarray(0, unicodeOffset + 1));
  result.feed(metadataBytes.subarray(unicodeOffset + 1));
  result.feed(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }) + '\n');
  const bytes = Buffer.from(JSON.stringify(event('2026-09-10T02:00:00Z', usage(100))) + '\n');
  result.feed(bytes.subarray(0, 27));
  assert.equal(snapshot([result]).totals.total, 0);
  result.feed(bytes.subarray(27));
  assert.equal(snapshot([result]).totals.total, 110);
  assert.equal(snapshot([result]).sessions[0].cwd, 'C:/projects/\u4e2d\u6587');
});

test('incremental filesystem scan tracks appends and archived moves exactly once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-token-test-'));
  try {
    await mkdir(path.join(root, 'sessions'));
    await mkdir(path.join(root, 'archived_sessions'));
    const file = path.join(root, 'sessions', 'session.jsonl');
    const rows = [meta('desktop'), event('2026-09-10T02:00:00Z', usage(100))];
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const store = new UsageStore({ codexHome: root, minRefreshMs: 0 });
    const initial = await Promise.all([store.refresh(), store.refresh()]);
    assert.equal(initial[0], initial[1]);
    assert.equal(initial[0].totals.total, 110);
    const more = JSON.stringify(event('2026-09-10T03:00:00Z', usage(150, 20), usage(50, 10)));
    await appendFile(file, more.slice(0, 40));
    assert.equal((await store.refresh()).totals.total, 110);
    await appendFile(file, more.slice(40) + '\n');
    assert.equal((await store.refresh()).totals.total, 170);
    await rename(file, path.join(root, 'archived_sessions', 'session.jsonl'));
    assert.equal((await store.refresh()).totals.total, 170);
  } finally { await rm(root, { recursive: true, force: true }); }
});
