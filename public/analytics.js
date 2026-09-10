const COUNTERS = ['input', 'cached', 'cacheWrite', 'output', 'reasoning', 'total'];
const DAY_MS = 86400000;
const MAX_DAYS = 5000;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UNKNOWN_MODELS = new Set(['', 'unknown', 'unrecorded', '未记录', '未知']);
const empty = () => Object.fromEntries(COUNTERS.map((key) => [key, 0]));
const quantity = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const counters = (value) => {
  const result = Object.fromEntries(COUNTERS.map((key) => [key, quantity(value?.[key])]));
  if (value?.total == null) result.total = result.input + result.output;
  return result;
};
const add = (target, value) => { for (const key of COUNTERS) target[key] += quantity(value?.[key]); };
const hasUsage = (value) => COUNTERS.some((key) => value[key] > 0);
const modelName = (value) => typeof value === 'string' ? value : '';
const isUnknown = (name) => UNKNOWN_MODELS.has(name.trim().toLowerCase());
const validRate = (value) => value && ['input', 'cached', 'output'].every((key) =>
  typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);

function dateTime(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const time = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? time : NaN;
}

export function validateDateRange(from, to) {
  const start = dateTime(from);
  const end = dateTime(to);
  return Number.isFinite(start) && Number.isFinite(end) && start <= end && (end - start) / DAY_MS < MAX_DAYS;
}

export function shiftDate(date, offset) {
  const time = dateTime(date);
  if (!Number.isFinite(time) || !Number.isSafeInteger(offset)) return null;
  const shifted = new Date(time + offset * DAY_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  const result = shifted.toISOString().slice(0, 10);
  return Number.isFinite(dateTime(result)) ? result : null;
}

export function dateRange(from, to) {
  if (!validateDateRange(from, to)) return [];
  const count = (dateTime(to) - dateTime(from)) / DAY_MS + 1;
  return Array.from({ length: count }, (_, index) => shiftDate(from, index));
}

function addModels(target, models) {
  for (const entry of models) {
    const model = modelName(entry?.model);
    if (!target.has(model)) target.set(model, { model, ...empty() });
    add(target.get(model), counters(entry));
  }
}

function sortedModels(models) {
  return [...models.values()].sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
}

// Keep unattributed tokens visible in cost coverage when a log has no model context.
function bucketModels(bucket) {
  const models = Array.isArray(bucket?.models)
    ? bucket.models.map((entry) => ({ model: modelName(entry?.model), ...counters(entry) })) : [];
  const assigned = empty();
  for (const model of models) add(assigned, model);
  const count = counters(bucket);
  const missing = Object.fromEntries(COUNTERS.map((key) => [key, Math.max(0, count[key] - assigned[key])]));
  if (hasUsage(missing)) models.push({ model: '', ...missing });
  return models;
}

export function selectRange(sessions, from, to) {
  const dates = dateRange(from, to);
  const totals = empty();
  const result = { totals, models: [], days: [], sessions: [] };
  if (!dates.length) return result;
  const days = new Map(dates.map((date) => [date, { date, ...empty(), models: new Map() }]));
  const allModels = new Map();
  for (const source of Array.isArray(sessions) ? sessions : []) {
    const count = empty();
    const selectedModels = new Map();
    const selectedDays = [];
    for (const bucket of Array.isArray(source.days) ? source.days : []) {
      if (!days.has(bucket.date)) continue;
      const value = counters(bucket);
      const models = bucketModels(bucket);
      selectedDays.push({ date: bucket.date, ...value, models });
      add(count, value);
      add(days.get(bucket.date), value);
      addModels(selectedModels, models);
      addModels(days.get(bucket.date).models, models);
    }
    if (!hasUsage(count)) continue;
    const models = sortedModels(selectedModels);
    add(totals, count);
    addModels(allModels, models);
    result.sessions.push({
      ...source, ...count, models,
      days: selectedDays.sort((a, b) => a.date.localeCompare(b.date)),
      hours: (Array.isArray(source.hours) ? source.hours : []).filter((bucket) => days.has(bucket.date))
        .map((bucket) => ({ date: bucket.date, hour: bucket.hour, ...counters(bucket), models: bucketModels(bucket) })),
    });
  }
  result.models = sortedModels(allModels);
  result.days = [...days.values()].map((bucket) => ({ ...bucket, models: sortedModels(bucket.models) }));
  return result;
}

export function hourlySeries(sessions, date) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ date, hour, ...empty(), models: new Map() }));
  if (Number.isFinite(dateTime(date))) {
    for (const session of Array.isArray(sessions) ? sessions : []) {
      for (const bucket of Array.isArray(session.hours) ? session.hours : []) {
        if (bucket.date !== date || !Number.isInteger(bucket.hour) || bucket.hour < 0 || bucket.hour > 23) continue;
        add(hours[bucket.hour], counters(bucket));
        addModels(hours[bucket.hour].models, bucketModels(bucket));
      }
    }
  }
  return hours.map((bucket) => ({ ...bucket, models: sortedModels(bucket.models) }));
}

export function estimateCost(models, rates = {}) {
  let amount = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const missing = new Set();
  for (const entry of Array.isArray(models) ? models : []) {
    const model = modelName(entry?.model);
    const count = counters(entry);
    const tokens = count.input + count.output;
    if (!tokens) continue;
    const rate = !isUnknown(model) && !UNSAFE_KEYS.has(model) && rates && Object.hasOwn(rates, model) ? rates[model] : null;
    const cached = count.cached;
    const cost = validRate(rate)
      ? Math.max(0, count.input - cached) / 1e6 * rate.input + cached / 1e6 * rate.cached + count.output / 1e6 * rate.output
      : NaN;
    if (!Number.isFinite(cost) || !Number.isFinite(amount + cost)) {
      unpricedTokens += tokens;
      missing.add(model);
      continue;
    }
    amount += cost;
    pricedTokens += tokens;
  }
  return { amount, complete: unpricedTokens === 0, pricedTokens, unpricedTokens, missingModels: [...missing].sort() };
}

export function normalizePricing(raw) {
  const result = { currency: raw?.currency === 'CNY' ? 'CNY' : 'USD', tables: { USD: {}, CNY: {} } };
  for (const currency of ['USD', 'CNY']) {
    const table = raw?.tables?.[currency];
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const [model, rate] of Object.entries(table)) {
      if (UNSAFE_KEYS.has(model) || isUnknown(model) || !validRate(rate)) continue;
      result.tables[currency][model] = { input: rate.input, cached: rate.cached, output: rate.output };
    }
  }
  return result;
}

export function createAliases(sessions) {
  const ids = new Set();
  const paths = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    for (const id of [session.id, session.parentId]) if (typeof id === 'string' && id) ids.add(id);
    if (typeof session.cwd === 'string' && session.cwd) paths.add(session.cwd);
  }
  const map = (values, prefix) => new Map([...values].sort().map((value, index) => [value, `${prefix} ${String(index + 1).padStart(3, '0')}`]));
  const sessionAliases = map(ids, '会话');
  const projectAliases = map(paths, '项目');
  return {
    session: (id) => sessionAliases.get(id) || '未知会话',
    project: (cwd) => projectAliases.get(cwd) || '未记录项目',
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(sessions, { privacy = false, aliases, from = '', to = '', currency = 'USD', rates = {} } = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const names = aliases || createAliases(rows);
  const header = ['会话', '父会话', '标题', '类型', '项目', '模型', '起始日期', '结束日期', '输入 Token', '缓存输入 Token', '缓存写入 Token', '输出 Token', '推理输出 Token', '总 Token', '参考费用', '币种', '费用覆盖', '已定价 Token', '未定价 Token', '最近活动'];
  const values = rows.map((session) => {
    const count = counters(session);
    const models = bucketModels(session);
    const cost = estimateCost(models, rates);
    const name = privacy ? names.session(session.id) : session.id;
    return [
      name, session.parentId ? privacy ? names.session(session.parentId) : session.parentId : '',
      privacy ? name : session.title || '', session.kind === 'subagent' ? '子代理' : '主会话',
      privacy ? names.project(session.cwd) : session.cwd || '',
      [...new Set(models.map((model) => model.model || '未记录'))].join(' / '), from, to,
      count.input, count.cached, count.cacheWrite, count.output, count.reasoning, count.total,
      cost.complete ? cost.amount.toFixed(8) : '', currency === 'CNY' ? 'CNY' : 'USD',
      cost.complete ? '完整' : '不完整', cost.pricedTokens, cost.unpricedTokens, session.updatedAt || '',
    ];
  });
  return '\uFEFF' + [header, ...values].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
