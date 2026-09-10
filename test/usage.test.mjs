import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlAccumulator, buildSnapshot, localDate, UsageStore } from '../usage.mjs';

const usage = (input, output = 10, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 2, total_tokens: input + output });
const meta = (id, extra = {}) => ({ type: 'session_meta', timestamp: '2026-09-10T01:00:00Z', payload: { id, originator: 'Codex Desktop', timestamp: '2026-09-10T01:00:00Z', ...extra } });
const event = (timestamp, total, last = total) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const parser = rows => { const result = new JsonlAccumulator(); result.feed(rows.map(row => JSON.stringify(row)).join('\n') + '\n'); return result; };
const snapshot = records => buildSnapshot(records, { now: new Date('2026-09-10T08:00:00Z') });

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
