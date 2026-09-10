import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export const COUNTERS = ['input', 'cached', 'cacheWrite', 'output', 'reasoning', 'total'];
const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
export const emptyCounters = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));
const add = (target, values) => { for (const key of COUNTERS) target[key] += values[key]; };
const equal = (a, b) => a && b && COUNTERS.every(key => a[key] === b[key]);
const isNumber = value => Number.isSafeInteger(value) && value >= 0;
const hasUsage = value => COUNTERS.some(key => value[key] > 0);
const modelValues = values => [...values.values()].sort((a, b) => a.model.localeCompare(b.model));

function addModel(values, model, usage) {
  if (!hasUsage(usage)) return;
  if (!values.has(model)) values.set(model, { model, ...emptyCounters() });
  add(values.get(model), usage);
}

function usageBucket(identity) {
  return { ...identity, ...emptyCounters(), models: new Map() };
}

function addBucket(bucket, delta, models) {
  add(bucket, delta);
  for (const values of models) addModel(bucket.models, values.model, values);
}

const serializeBucket = bucket => ({ ...bucket, models: modelValues(bucket.models) });

function attributedUsage(event, delta) {
  const models = new Map();
  const last = event.last;
  // A cumulative increment may include unobserved calls made with earlier models.
  const known = event.model && last && ['input', 'output', 'total'].every(key => last[key] <= delta[key]);
  if (!known) {
    addModel(models, '', delta);
  } else {
    const request = Object.fromEntries(COUNTERS.map(key => [key, Math.min(delta[key], last[key])]));
    const remainder = Object.fromEntries(COUNTERS.map(key => [key, delta[key] - request[key]]));
    addModel(models, event.model, request);
    addModel(models, '', remainder);
  }
  return modelValues(models);
}

function counters(value) {
  if (!value || !isNumber(value.input_tokens) || !isNumber(value.output_tokens)) return null;
  const result = Object.fromEntries(COUNTERS.map((key, i) => [key, isNumber(value[FIELDS[i]]) ? value[FIELDS[i]] : 0]));
  if (!isNumber(value.total_tokens)) result.total = result.input + result.output;
  return result;
}

export function localDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function metadata(payload, timestamp) {
  if (!payload || typeof payload.id !== 'string') return null;
  const spawn = payload.source?.subagent?.thread_spawn;
  const parentId = payload.parent_thread_id || spawn?.parent_thread_id || payload.forked_from_id || null;
  return {
    id: payload.id,
    parentId: typeof parentId === 'string' ? parentId : null,
    forkedFromId: typeof payload.forked_from_id === 'string' ? payload.forked_from_id : null,
    kind: payload.thread_source === 'subagent' || !!payload.source?.subagent ? 'subagent' : 'session',
    originator: typeof payload.originator === 'string' ? payload.originator : '',
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    createdAt: payload.timestamp || timestamp,
    model: typeof payload.model === 'string' ? payload.model : '',
  };
}

// Files can contain copied parent metadata. Only the first session_meta owns the file.
export class JsonlAccumulator {
  constructor() {
    this.meta = null;
    this.events = [];
    this.model = '';
    this.modelAt = '';
    this.pending = '';
    this.decoder = new StringDecoder('utf8');
    this.malformedLines = 0;
  }

  feed(buffer) {
    this.pending += typeof buffer === 'string' ? buffer : this.decoder.write(buffer);
    let offset = 0;
    let newline;
    while ((newline = this.pending.indexOf('\n', offset)) !== -1) {
      this.consume(this.pending.slice(offset, newline));
      offset = newline + 1;
    }
    this.pending = this.pending.slice(offset);
  }

  consume(line) {
    if (!line.trim()) return;
    // Large conversation records are discarded before JSON parsing.
    if (!line.includes('"session_meta"') && !line.includes('"token_count"') && !line.includes('"turn_context"')) return;
    let row;
    try { row = JSON.parse(line); } catch { this.malformedLines += 1; return; }
    if (row.type === 'session_meta') {
      if (!this.meta) this.meta = metadata(row.payload, row.timestamp);
      return;
    }
    if (row.type === 'turn_context' && typeof row.payload?.model === 'string') {
      this.model = row.payload.model;
      this.modelAt = row.timestamp || '';
      return;
    }
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count' || !row.payload.info) return;
    const timestamp = row.timestamp;
    if (!Number.isFinite(Date.parse(timestamp))) { this.malformedLines += 1; return; }
    const total = counters(row.payload.info.total_token_usage);
    if (!total) { this.malformedLines += 1; return; }
    this.events.push({ timestamp, total, last: counters(row.payload.info.last_token_usage), ordinal: row.ordinal ?? null, model: this.model || this.meta?.model || '' });
  }
}

function eventKey(event) {
  return JSON.stringify([event.timestamp, event.total, event.last]);
}

export function buildSnapshot(records, { now = new Date(), warnings = [], files = records.length } = {}) {
  const sessionsById = new Map();
  let malformedLines = 0;
  for (const record of records) {
    malformedLines += record.malformedLines || 0;
    if (!record.meta) continue;
    let session = sessionsById.get(record.meta.id);
    if (!session) {
      session = { ...record.meta, events: new Map(), modelAt: '', files: 0 };
      sessionsById.set(session.id, session);
    }
    session.files += 1;
    if (record.model && record.modelAt >= session.modelAt) {
      session.model = record.model;
      session.modelAt = record.modelAt;
    }
    for (const event of record.events) {
      const key = eventKey(event);
      const existing = session.events.get(key);
      if (!existing || (!existing.model && event.model)) session.events.set(key, event);
    }
  }

  const included = new Set([...sessionsById.values()].filter(session => session.originator === 'Codex Desktop').map(session => session.id));
  let changed;
  do {
    changed = false;
    for (const session of sessionsById.values()) {
      if (!included.has(session.id) && session.kind === 'subagent' && included.has(session.parentId)) {
        included.add(session.id);
        changed = true;
      }
    }
  } while (changed);

  const todayDate = localDate(now);
  const totals = emptyCounters();
  const today = emptyCounters();
  const modelsByName = new Map();
  const daysByDate = new Map();
  for (let i = 29; i >= 0; i -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const key = localDate(date);
    daysByDate.set(key, usageBucket({ date: key }));
  }
  const sessions = [];
  let resets = 0;
  let incompleteResets = 0;
  let inheritedEvents = 0;
  let ambiguousForks = 0;
  let firstDate = null;
  let lastDate = null;

  for (const id of included) {
    const source = sessionsById.get(id);
    const events = [...source.events.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const result = {
      id, parentId: source.parentId, kind: source.kind, title: id.slice(0, 8),
      cwd: source.cwd, model: source.model || '', createdAt: source.createdAt,
      updatedAt: source.createdAt, files: source.files, ...emptyCounters(), today: emptyCounters(), days: [], hours: [], models: [],
    };
    const sessionDays = new Map();
    const sessionHours = new Map();
    const sessionModels = new Map();
    let previous = null;
    let hasOwnEvent = false;
    const isFork = !!source.forkedFromId;
    const createdAt = Date.parse(source.createdAt);
    const ancestorEvents = new Map();
    let ancestor = sessionsById.get(source.parentId);
    const seenParents = new Set([id]);
    while (ancestor && !seenParents.has(ancestor.id)) {
      seenParents.add(ancestor.id);
      for (const [key, event] of ancestor.events) ancestorEvents.set(key, event);
      ancestor = sessionsById.get(ancestor.parentId);
    }
    for (const event of events) {
      const inherited = isFork && (Date.parse(event.timestamp) < createdAt || ancestorEvents.has(eventKey(event)));
      if (inherited) {
        previous = event.total;
        inheritedEvents += 1;
        continue;
      }
      let delta = emptyCounters();
      if (!hasOwnEvent && isFork && equal(event.total, event.last)) {
        delta = event.total;
      } else if (!previous) {
        if (isFork && !equal(event.total, event.last)) {
          // Without an inherited baseline, only the latest request is attributable.
          delta = event.last || emptyCounters();
          ambiguousForks += 1;
        } else {
          delta = event.total;
        }
      } else if (event.total.input >= previous.input && event.total.output >= previous.output && event.total.total >= previous.total) {
        delta = Object.fromEntries(COUNTERS.map(key => [key, Math.max(0, event.total[key] - previous[key])]));
      } else {
        resets += 1;
        if (event.last && COUNTERS.every(key => event.last[key] <= event.total[key])) delta = event.last;
        else incompleteResets += 1;
      }
      previous = event.total;
      hasOwnEvent = true;
      result.updatedAt = event.timestamp;
      const date = localDate(event.timestamp);
      const hour = new Date(event.timestamp).getHours();
      const hourKey = `${date}:${hour}`;
      const attributed = attributedUsage(event, delta);
      if (!sessionDays.has(date)) sessionDays.set(date, usageBucket({ date }));
      if (!sessionHours.has(hourKey)) sessionHours.set(hourKey, usageBucket({ date, hour }));
      if (!daysByDate.has(date)) daysByDate.set(date, usageBucket({ date }));
      addBucket(sessionDays.get(date), delta, attributed);
      addBucket(sessionHours.get(hourKey), delta, attributed);
      addBucket(daysByDate.get(date), delta, attributed);
      for (const values of attributed) {
        addModel(sessionModels, values.model, values);
        addModel(modelsByName, values.model, values);
      }
      add(result, delta);
      add(totals, delta);
      if (date === todayDate) { add(result.today, delta); add(today, delta); }
      if (hasUsage(delta)) {
        if (!firstDate || date < firstDate) firstDate = date;
        if (!lastDate || date > lastDate) lastDate = date;
      }
    }
    result.days = [...sessionDays.values()].map(serializeBucket).sort((a, b) => a.date.localeCompare(b.date));
    result.hours = [...sessionHours.values()].map(serializeBucket).sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
    result.models = modelValues(sessionModels);
    sessions.push(result);
  }
  if (malformedLines) warnings.push(`${malformedLines} token or metadata records could not be parsed.`);
  if (incompleteResets) warnings.push(`${incompleteResets} counter resets lacked request usage; their reset event was excluded.`);
  if (ambiguousForks) warnings.push(`${ambiguousForks} forks lacked inherited baselines; only known request usage was counted at their first event.`);
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    generatedAt: new Date(now).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    todayDate, totals, today, models: modelValues(modelsByName),
    days: [...daysByDate.values()].map(serializeBucket).sort((a, b) => a.date.localeCompare(b.date)), sessions,
    coverage: { files, sessions: sessions.length, excludedSessions: sessionsById.size - included.size, resets, malformedLines, inheritedEvents, firstDate: firstDate || todayDate, lastDate: lastDate || todayDate, warnings },
  };
}

async function listJsonl(directory, files, warnings) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') warnings.push('A session directory could not be read.'); return; }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await listJsonl(filename, files, warnings);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(filename);
  }
}

export class UsageStore {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), minRefreshMs = 1000 } = {}) {
    this.roots = ['sessions', 'archived_sessions'].map(name => path.join(codexHome, name));
    this.files = new Map();
    this.inflight = null;
    this.snapshot = null;
    this.lastRefresh = 0;
    this.minRefreshMs = minRefreshMs;
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    if (this.snapshot && Date.now() - this.lastRefresh < this.minRefreshMs) return this.snapshot;
    this.inflight = this.scan().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async scan() {
    const names = [];
    const warnings = [];
    for (const root of this.roots) await listJsonl(root, names, warnings);
    const present = new Set(names);
    for (const filename of this.files.keys()) if (!present.has(filename)) this.files.delete(filename);
    for (const filename of names) {
      let handle;
      try {
        const info = await stat(filename);
        let record = this.files.get(filename);
        if (!record || info.size < record.offset || info.ino !== record.ino || (info.size === record.offset && info.mtimeMs !== record.mtimeMs)) {
          record = { parser: new JsonlAccumulator(), offset: 0, ino: info.ino, mtimeMs: 0 };
          this.files.set(filename, record);
        }
        if (info.size > record.offset) {
          handle = await open(filename, 'r');
          const buffer = Buffer.allocUnsafe(256 * 1024);
          while (record.offset < info.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - record.offset), record.offset);
            if (!bytesRead) break;
            record.parser.feed(buffer.subarray(0, bytesRead));
            record.offset += bytesRead;
          }
        }
        record.mtimeMs = info.mtimeMs;
      } catch { warnings.push('A session file could not be read; the next refresh will retry.'); }
      finally { if (handle) await handle.close(); }
    }
    this.snapshot = buildSnapshot([...this.files.values()].map(record => record.parser), { warnings, files: names.length });
    this.lastRefresh = Date.now();
    return this.snapshot;
  }
}
