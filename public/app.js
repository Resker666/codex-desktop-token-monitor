import { selectRange, hourlySeries, shiftDate, dateRange, validateDateRange, estimateCost, normalizePricing, createAliases, buildCsv } from './analytics.js';

const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat('zh-CN');
const zero = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
const colors = ['#16846a', '#6d9fd7', '#e6a049'];
const storageKey = 'codex-token-monitor.preferences.v2';
const pageSize = 15;
const state = { data: null, selected: null, aliases: createAliases([]), preset: 'today', from: '', to: '', hourDate: '', chartMode: 'hour', privacy: false, csvRedact: true, pricing: normalizePricing(null), pricingDraft: null, pricingModels: [], search: '', kind: 'all', sort: 'total', direction: -1, page: 1, busy: false, stale: false, chartBars: [], visibleRows: [], dialogId: null };
const fmt = (n) => number.format(Number(n) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const compact = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : String(Math.round(n));
const icons = () => window.lucide?.createIcons();
const child = (s) => s.kind === 'subagent';
const rates = () => state.pricing.tables[state.pricing.currency];
const costOf = (s) => estimateCost(s.models, rates());
const money = (n) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: state.pricing.currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
const costText = (cost) => cost.complete ? money(cost.amount) : cost.pricedTokens ? `${money(cost.amount)} + 未定价` : '未配置';
const modelNames = (s) => [...new Set((s.models || []).filter((m) => m.total > 0 || m.input > 0 || m.output > 0).map((m) => m.model || '未记录'))];
const modelLabel = (s) => { const names = modelNames(s); return names.length > 1 ? `多模型 (${names.length})` : names[0] || '未记录'; };
const sessionName = (s) => state.privacy ? state.aliases.session(s.id) : s.title && s.title !== s.id && s.title !== s.id.slice(0, 8) ? s.title : `${child(s) ? '子代理' : '会话'} ${s.id.slice(-8)}`;
const projectName = (s) => state.privacy ? state.aliases.project(s.cwd) : (s.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '未命名项目';
const projectPath = (s) => state.privacy ? state.aliases.project(s.cwd) : s.cwd || '未记录';
const time = (v, full = false) => v && !Number.isNaN(Date.parse(v)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: state.data?.timezone || 'Asia/Shanghai', ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: full ? undefined : '2-digit', hour12: false }).format(new Date(v)) : '--';

function preferencesNotice(message) {
  $('#preferences-error').hidden = !message;
  $('#preferences-error').textContent = message;
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const prefs = JSON.parse(raw);
    state.privacy = prefs?.privacy === true;
    state.csvRedact = prefs?.csvRedact !== false;
    state.pricing = normalizePricing(prefs?.pricing);
  } catch {
    preferencesNotice('本地偏好无法读取，已使用默认设置。');
  }
}

function savePreferences() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ privacy: state.privacy, csvRedact: state.csvRedact, pricing: state.pricing }));
    preferencesNotice('');
  } catch {
    preferencesNotice('浏览器无法保存偏好，当前设置仅在本次打开期间生效。');
  }
}

function renderPrivacy() {
  const button = $('#privacy-toggle');
  button.setAttribute('aria-pressed', String(state.privacy));
  button.title = state.privacy ? '关闭隐私模式' : '开启隐私模式';
  button.innerHTML = `<i data-lucide="${state.privacy ? 'eye-off' : 'eye'}"></i>`;
  $('#csv-redact').checked = state.privacy || state.csvRedact;
  $('#csv-redact').disabled = state.privacy;
  $('#search').placeholder = state.privacy ? '搜索会话别名、项目别名或模型' : '搜索会话、项目或模型';
  $('#search').setAttribute('aria-label', $('#search').placeholder);
  icons();
}

function todayDate() {
  if (state.data?.todayDate) return state.data.todayDate;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: state.data?.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(state.data?.generatedAt || Date.now()));
  return ['year', 'month', 'day'].map((name) => parts.find((p) => p.type === name).value).join('-');
}

function applyPreset(preset) {
  const today = todayDate();
  const first = state.data?.coverage?.firstDate || today;
  state.preset = preset;
  state.to = today;
  state.from = preset === 'all' ? first : preset === 'today' ? today : [shiftDate(today, 1 - Number(preset)), first].sort().at(-1);
  state.hourDate = state.to;
  state.page = 1;
  $('#range-error').hidden = true;
  render();
}

function renderRange() {
  const first = state.data.coverage?.firstDate || todayDate();
  for (const input of [$('#range-from'), $('#range-to')]) {
    input.min = first;
    input.max = todayDate();
  }
  if (!$('#range-form').contains(document.activeElement) || document.activeElement.tagName !== 'INPUT') {
    $('#range-from').value = state.from;
    $('#range-to').value = state.to;
  }
  document.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === state.preset)));
  if (!state.hourDate || state.hourDate < state.from || state.hourDate > state.to) state.hourDate = state.to;
  $('#hour-date').min = state.from;
  $('#hour-date').max = state.to;
  $('#hour-date').value = state.hourDate;
  $('#selected-range-label').textContent = state.from === state.to ? state.from : `${state.from} 至 ${state.to}`;
  $('#range-total-label').textContent = state.preset === 'today' ? '今日 Token' : state.preset === 'all' ? '累计 Token' : '范围内 Token';
}

function filteredSessions() {
  const query = state.search.trim().toLowerCase();
  return (state.selected?.sessions || []).filter((s) => {
    if (state.kind === 'main' && child(s) || state.kind === 'subagent' && !child(s)) return false;
    const values = state.privacy ? [sessionName(s), projectName(s), ...modelNames(s)] : [s.id, s.parentId, s.title, s.cwd, ...modelNames(s)];
    return !query || values.some((v) => String(v || '').toLowerCase().includes(query));
  }).sort((a, b) => {
    const value = (s) => {
      if (state.sort === 'updatedAt') return Date.parse(s.updatedAt) || 0;
      if (state.sort !== 'cost') return s[state.sort] || 0;
      const cost = costOf(s);
      return cost.pricedTokens || cost.complete ? cost.amount : -1;
    };
    return state.direction * (value(a) - value(b)) || a.id.localeCompare(b.id);
  });
}

function render() {
  const data = state.data;
  if (!data) return;
  renderRange();
  state.selected = selectRange(data.sessions, state.from, state.to);
  const count = state.selected.totals;
  const active = state.selected.sessions;
  const children = active.filter(child).length;
  const cost = estimateCost(state.selected.models, rates());
  $('#today-total').textContent = fmt(count.total);
  $('#all-total').textContent = `累计 ${fmt(data.totals.total)} Token · ${fmt(data.sessions.length)} 个会话`;
  $('#today-split').textContent = `输入 ${compact(count.input)} / 输出 ${compact(count.output)}`;
  $('#estimated-cost').textContent = cost.pricedTokens || cost.complete ? money(cost.amount) : '--';
  $('#estimated-cost').classList.toggle('partial-cost', !cost.complete);
  $('#cost-coverage').textContent = cost.complete ? `${state.pricing.currency} · 已全部定价 · 非实际账单` : `${state.pricing.currency} · ${cost.pricedTokens ? '部分估算' : '未配置单价'} · ${fmt(cost.unpricedTokens)} Token 未定价`;
  $('#cache-rate').textContent = count.input ? `${(count.cached / count.input * 100).toFixed(1)}%` : '--';
  $('#cached-total').textContent = `${fmt(count.cached)} 缓存输入 Token`;
  $('#active-sessions').textContent = fmt(active.length);
  $('#active-split').textContent = `主会话 ${active.length - children} / 子代理 ${children}`;
  $('#uncached-value').textContent = fmt(Math.max(0, count.input - count.cached));
  $('#cached-value').textContent = fmt(count.cached);
  $('#output-value').textContent = fmt(count.output);
  $('#reasoning-value').textContent = fmt(count.reasoning);
  const parts = [Math.max(0, count.input - count.cached), count.cached, count.output];
  $('#composition-bar').replaceChildren(...parts.map((n, i) => {
    const segment = document.createElement('span');
    segment.style.width = `${count.total ? n / count.total * 100 : 0}%`;
    segment.style.background = colors[i];
    return segment;
  }));
  $('#current-date').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: data.timezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(data.generatedAt));
  $('#updated-at').textContent = `${state.stale ? '上次更新' : '更新于'} ${time(data.generatedAt)}`;
  $('#timezone').textContent = data.timezone || 'Asia/Shanghai';
  $('#coverage-range').textContent = data.coverage?.firstDate ? `记录 ${data.coverage.firstDate} 至 ${data.coverage.lastDate || todayDate()}` : '暂无用量记录';
  const warnings = data.coverage?.warnings || [];
  $('#warning').hidden = !warnings.length;
  $('#warning').textContent = state.privacy ? `${fmt(warnings.length)} 项日志读取提示，部分记录可能未计入。` : warnings.map((w) => typeof w === 'string' ? w : w.message || '部分日志无法读取').join('；');
  drawChart();
  renderTable();
  if (state.dialogId && $('#session-dialog').open) renderDialog(state.dialogId);
}

function renderTable() {
  const rows = filteredSessions();
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.page = Math.max(1, Math.min(state.page, pages));
  const start = (state.page - 1) * pageSize;
  state.visibleRows = rows.slice(start, start + pageSize);
  $('#session-count').textContent = fmt(rows.length);
  $('#session-rows').innerHTML = state.visibleRows.map((s, index) => {
    const cost = costOf(s);
    return `<tr><td><button class="session-link" data-row="${index}" title="查看会话详情"><span class="session-icon"><i data-lucide="${child(s) ? 'git-branch' : 'message-square'}"></i></span><span class="session-text"><span class="session-name">${esc(sessionName(s))}</span><span class="session-project" title="${esc(projectPath(s))}">${esc(projectName(s))}${child(s) ? ' · 子代理' : ''}</span></span></button></td><td class="model" title="${esc(modelNames(s).join(' / '))}">${esc(modelLabel(s))}</td><td class="numeric">${fmt(s.input)}</td><td class="numeric cached-cell">${fmt(s.cached)}</td><td class="numeric">${fmt(s.output)}</td><td class="numeric total-cell">${fmt(s.total)}</td><td class="numeric cost-cell${cost.complete ? '' : ' partial-cost'}" title="${cost.complete ? '已全部定价' : `${fmt(cost.unpricedTokens)} Token 未定价`}">${esc(costText(cost))}</td><td class="numeric time-cell" title="${esc(s.updatedAt)}">${time(s.updatedAt, true)}</td></tr>`;
  }).join('');
  $('#empty-state').hidden = rows.length > 0;
  $('#table-summary').textContent = rows.length ? `${start + 1}-${Math.min(start + pageSize, rows.length)} / ${rows.length} 个会话 · 合计 ${fmt(rows.reduce((sum, s) => sum + s.total, 0))} Token` : '0 个会话';
  $('#page-label').textContent = `${state.page} / ${pages}`;
  $('#prev-page').disabled = state.page <= 1;
  $('#next-page').disabled = state.page >= pages;
  $('#export').disabled = rows.length === 0;
  document.querySelectorAll('[data-sort]').forEach((button) => {
    const selected = state.sort === button.dataset.sort;
    button.closest('th').removeAttribute('aria-sort');
    if (selected) button.closest('th').setAttribute('aria-sort', state.direction > 0 ? 'ascending' : 'descending');
    button.querySelector('svg, i')?.remove();
    button.insertAdjacentHTML('beforeend', `<i data-lucide="${selected ? state.direction > 0 ? 'arrow-up' : 'arrow-down' : 'chevrons-up-down'}"></i>`);
  });
  icons();
}

function chartData() {
  if (!state.selected) return { rows: [], previous: null };
  const hourly = state.chartMode === 'hour';
  const dates = dateRange(state.from, state.to);
  const previousFrom = shiftDate(hourly ? state.hourDate : state.from, hourly ? -1 : -dates.length);
  const previousTo = hourly ? previousFrom : shiftDate(state.from, -1);
  const first = state.data.coverage?.firstDate;
  const last = state.data.coverage?.lastDate;
  const available = !!first && !!last && previousFrom >= first && previousTo <= last;
  const source = hourly ? hourlySeries(state.data.sessions, state.hourDate) : state.selected.days;
  const previous = available && $('#compare-enabled').checked ? hourly ? hourlySeries(state.data.sessions, previousFrom) : selectRange(state.data.sessions, previousFrom, previousTo).days : null;
  $('#compare-label').textContent = hourly ? '对比前一天' : '对比上一等长周期';
  $('#compare-legend').hidden = !previous;
  const previousTotal = previous?.reduce((sum, d) => sum + d.total, 0);
  const total = source.reduce((sum, d) => sum + d.total, 0);
  $('#comparison-status').textContent = !$('#compare-enabled').checked ? '' : !available ? '对比期记录不足' : `对比期 ${compact(previousTotal)} Token${(hourly ? state.hourDate : state.to) < todayDate() && previousTotal > 0 ? ` · ${total >= previousTotal ? '+' : ''}${((total / previousTotal - 1) * 100).toFixed(1)}%` : ''}`;
  $('#comparison-status').title = available ? `${previousFrom}${previousFrom === previousTo ? '' : ` 至 ${previousTo}`}` : '对比日期超出本地记录覆盖范围';
  const groupSize = Math.max(1, Math.ceil(source.length / 100));
  const rows = [];
  const comparisons = previous ? [] : null;
  for (let index = 0; index < source.length; index += groupSize) {
    const sum = (values) => values.reduce((result, value) => { for (const key of Object.keys(zero)) result[key] += value[key] || 0; return result; }, { ...zero });
    const group = source.slice(index, index + groupSize);
    rows.push({ ...sum(group), date: group[0].date, hour: group[0].hour, endDate: group.at(-1).date, label: hourly ? `${String(group[0].hour).padStart(2, '0')}:00` : group[0].date.slice(5).replace('-', '/') });
    if (previous) comparisons.push(sum(previous.slice(index, index + groupSize)));
  }
  return { rows, previous: comparisons, total, grouped: groupSize > 1, hourly };
}

function drawChart() {
  const canvas = $('#usage-chart');
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height || !state.selected) return;
  $('#chart-tooltip').hidden = true;
  const { rows, previous, total, grouped, hourly } = chartData();
  if (!rows.length) return;
  $('#trend-title').textContent = hourly ? '小时用量' : '每日用量';
  $('#trend-total').textContent = `${hourly ? `${state.hourDate} · ` : ''}${fmt(total)} Token${grouped ? ' · 已按区间汇总' : ''}`;
  $('#hour-date-control').hidden = !hourly;
  document.querySelectorAll('[data-chart-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chartMode === state.chartMode)));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const maximum = Math.max(...rows.map((d) => d.total), ...(previous || []).map((d) => d.total), 1);
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const ymax = Math.ceil(maximum / magnitude) * magnitude;
  const pad = { left: 45, right: 12, top: 15, bottom: 32 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const cellWidth = plotWidth / rows.length;
  const barWidth = Math.min(44, cellWidth * .62);
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + plotHeight * (1 - i / 4);
    ctx.strokeStyle = '#e4ebe6';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y + .5); ctx.lineTo(width - pad.right, y + .5); ctx.stroke();
    ctx.fillStyle = '#8d9b92';
    ctx.fillText(compact(ymax * i / 4), pad.left - 9, y + 3);
  }
  const stride = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(plotWidth / 55))));
  state.chartBars = rows.map((day, i) => {
    const x = pad.left + cellWidth * (i + .5) - barWidth / 2;
    let y = pad.top + plotHeight;
    const parts = [Math.max(0, day.input - day.cached), day.cached, day.output];
    for (let j = 0; j < parts.length; j++) {
      const h = parts[j] / ymax * plotHeight;
      y -= h;
      ctx.fillStyle = colors[j];
      ctx.fillRect(x, y, barWidth, h);
    }
    if (!day.total) { ctx.fillStyle = '#dae4dd'; ctx.fillRect(x, pad.top + plotHeight - 2, barWidth, 2); }
    if (i % stride === 0 || i === rows.length - 1 && (i % stride) * cellWidth >= 40) {
      ctx.fillStyle = '#77867d'; ctx.textAlign = 'center';
      ctx.fillText(day.label, x + barWidth / 2, height - 10);
    }
    return { x: pad.left + cellWidth * i, width: cellWidth, day, previous: previous?.[i] };
  });
  if (previous) {
    ctx.strokeStyle = '#87928d'; ctx.lineWidth = 1.6; ctx.setLineDash([4, 4]); ctx.beginPath();
    previous.forEach((day, i) => { const x = pad.left + cellWidth * (i + .5); const y = pad.top + plotHeight * (1 - day.total / ymax); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
    if (previous.length === 1) { ctx.fillStyle = '#87928d'; ctx.beginPath(); ctx.arc(pad.left + cellWidth / 2, pad.top + plotHeight * (1 - previous[0].total / ymax), 3, 0, Math.PI * 2); ctx.fill(); }
  }
  canvas.setAttribute('aria-label', `${hourly ? `${state.hourDate} 小时` : `${state.from} 至 ${state.to} 每日`} Token 用量，合计 ${fmt(total)}。${rows.map((d) => `${hourly ? d.label : d.date === d.endDate ? d.date : `${d.date} 至 ${d.endDate}`}: ${fmt(d.total)}`).join('；')}`);
}

function renderDialog(id) {
  const source = state.data.sessions.find((row) => row.id === id);
  if (!source) { $('#session-dialog').close(); return; }
  const selected = state.selected.sessions.find((row) => row.id === id) || { ...source, ...zero, models: [] };
  const cost = costOf(selected);
  const allCost = costOf(source);
  const fields = [['input', '输入'], ['cached', '其中：缓存输入'], ['cacheWrite', '缓存写入'], ['output', '输出'], ['reasoning', '其中：推理输出'], ['total', '合计']];
  const parent = source.parentId ? state.data.sessions.find((s) => s.id === source.parentId) : null;
  $('#session-detail').innerHTML = `<div class="detail-meta"><b>${esc(sessionName(source))}</b><br>${esc(state.privacy ? state.aliases.session(source.id) : source.id)}<br><br>类型：${child(source) ? '子代理' : '主会话'}<br>范围内模型：${esc(modelNames(selected).join(' / ') || '未记录')}<br>项目：${esc(projectPath(source))}<br>最近活动：${esc(source.updatedAt ? new Date(source.updatedAt).toLocaleString('zh-CN', { timeZone: state.data.timezone, hour12: false }) : '--')}</div><table class="detail-stats"><thead><tr><th>Token</th><th>所选范围</th><th>累计</th></tr></thead><tbody>${fields.map(([field, name]) => `<tr><td>${name}</td><td>${fmt(selected[field])}</td><td>${fmt(source[field])}</td></tr>`).join('')}<tr><td>参考费用 (${state.pricing.currency})</td><td>${esc(costText(cost))}</td><td>${esc(costText(allCost))}</td></tr></tbody></table><p class="detail-cost-note muted">${state.from} 至 ${state.to}${cost.complete ? ' · 已全部定价' : ` · ${fmt(cost.unpricedTokens)} Token 未定价`} · 非实际账单</p>${source.parentId ? parent ? '<button class="detail-parent" data-parent="true"><i data-lucide="corner-up-left"></i>查看所属会话</button>' : '<p class="muted">所属会话未在本地记录中找到</p>' : ''}`;
  icons();
}

function knownModels() {
  const unknown = new Set(['', 'unknown', 'unrecorded', '未记录', '未知', '__proto__', 'prototype', 'constructor']);
  const models = (state.data?.sessions || []).flatMap((s) => (s.models || []).map((m) => m.model));
  return [...new Set([...models, ...Object.keys(state.pricingDraft?.tables.USD || {}), ...Object.keys(state.pricingDraft?.tables.CNY || {})])].filter((model) => typeof model === 'string' && !unknown.has(model.trim().toLowerCase())).sort();
}

function renderPricing() {
  const draft = state.pricingDraft;
  state.pricingModels = knownModels();
  $('#pricing-currency').value = draft.currency;
  $('#pricing-rows').innerHTML = state.pricingModels.map((model, index) => {
    const value = draft.tables[draft.currency][model];
    return `<div class="pricing-row"><span class="pricing-model" title="${esc(model)}">${esc(model)}</span>${[['input', '未缓存输入'], ['cached', '缓存输入'], ['output', '输出']].map(([field, label]) => `<label><span>${label}</span><input type="number" min="0" step="any" inputmode="decimal" autocomplete="off" data-price-row="${index}" data-price-field="${field}" aria-label="${esc(model)} ${label}单价" placeholder="未设置" value="${value ? value[field] : ''}"></label>`).join('')}</div>`;
  }).join('');
  $('#pricing-empty').hidden = !!state.pricingModels.length;
  $('#pricing-error').hidden = true;
}

function capturePricing() {
  const table = { ...state.pricingDraft.tables[state.pricingDraft.currency] };
  for (let index = 0; index < state.pricingModels.length; index++) {
    const model = state.pricingModels[index];
    const inputs = [...document.querySelectorAll(`[data-price-row="${index}"]`)];
    const values = inputs.map((input) => input.value.trim());
    if (values.every((v) => !v) && inputs.every((input) => !input.validity.badInput)) { delete table[model]; continue; }
    if (values.some((v) => !v || !Number.isFinite(Number(v)) || Number(v) < 0) || inputs.some((input) => !input.validity.valid)) {
      $('#pricing-error').textContent = `${model}：请填写三项非负单价，或将三项全部留空。`;
      $('#pricing-error').hidden = false;
      inputs.find((input) => !input.value || !input.validity.valid)?.focus();
      return false;
    }
    table[model] = Object.fromEntries(inputs.map((input) => [input.dataset.priceField, Number(input.value)]));
  }
  state.pricingDraft.tables[state.pricingDraft.currency] = table;
  $('#pricing-error').hidden = true;
  return true;
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  $('#refresh').disabled = true;
  $('#refresh').querySelector('svg')?.classList.add('spin');
  try {
    const response = await fetch('/api/usage', { cache: 'no-store', signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.sessions) || !data.totals) throw new Error('用量数据格式不正确');
    state.data = data;
    state.stale = false;
    state.aliases = createAliases(data.sessions);
    $('#loading').hidden = true;
    $('#error').hidden = true;
    $('#status-dot').className = 'status-dot ready';
    $('#connection-status').textContent = $('#auto-refresh').checked ? '本地 · 已连接' : '本地 · 已暂停';
    if (!state.from) applyPreset(state.preset);
    else {
      if (state.preset) {
        const today = todayDate();
        const first = data.coverage?.firstDate || today;
        state.from = state.preset === 'all' ? first : state.preset === 'today' ? today : [shiftDate(today, 1 - Number(state.preset)), first].sort().at(-1);
        const followedToday = state.hourDate === state.to;
        state.to = today;
        if (followedToday) state.hourDate = today;
      }
      render();
    }
  } catch (error) {
    state.stale = true;
    $('#loading').hidden = true;
    $('#error').hidden = false;
    const reason = error.name === 'TimeoutError' ? '读取超时' : /^HTTP \d+$/.test(error.message) ? error.message : '请检查本地监控服务';
    $('#error').textContent = `暂时无法读取用量数据${state.data ? '，当前保留上次结果' : ''}。${reason}`;
    $('#status-dot').className = 'status-dot failed';
    $('#connection-status').textContent = '连接中断';
    if (state.data) $('#updated-at').textContent = `上次更新 ${time(state.data.generatedAt)}`;
  } finally {
    state.busy = false;
    $('#refresh').disabled = false;
    $('#refresh').querySelector('svg')?.classList.remove('spin');
  }
}

function exportCsv() {
  const csv = buildCsv(filteredSessions(), { privacy: state.privacy || state.csvRedact, aliases: state.aliases, from: state.from, to: state.to, currency: state.pricing.currency, rates: rates() });
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `codex-tokens-${state.from}-${state.to}${state.privacy || state.csvRedact ? '-private' : ''}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#refresh').addEventListener('click', refresh);
$('#auto-refresh').addEventListener('change', () => { if ($('#auto-refresh').checked) refresh(); else if (!state.stale) $('#connection-status').textContent = '本地 · 已暂停'; });
$('#privacy-toggle').addEventListener('click', () => {
  state.privacy = !state.privacy;
  state.search = ''; state.page = 1; $('#search').value = '';
  $('#session-detail').replaceChildren();
  savePreferences(); renderPrivacy(); render();
});
$('#csv-redact').addEventListener('change', (event) => { state.csvRedact = event.target.checked; savePreferences(); });
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => { if (state.data) applyPreset(button.dataset.range); }));
$('#range-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.data) return;
  const from = $('#range-from').value;
  const to = $('#range-to').value;
  if (!validateDateRange(from, to) || from < (state.data.coverage?.firstDate || todayDate()) || to > todayDate()) {
    $('#range-error').textContent = '请选择记录范围内的有效日期，开始日期不能晚于结束日期。'; $('#range-error').hidden = false; return;
  }
  state.from = from; state.to = to; state.preset = ''; state.page = 1;
  $('#range-error').hidden = true; render();
});
document.querySelectorAll('[data-chart-mode]').forEach((button) => button.addEventListener('click', () => { state.chartMode = button.dataset.chartMode; drawChart(); }));
$('#hour-date').addEventListener('change', (event) => { const date = event.target.value; if (validateDateRange(date, date) && date >= state.from && date <= state.to) { state.hourDate = date; drawChart(); } else event.target.value = state.hourDate; });
$('#compare-enabled').addEventListener('change', drawChart);
$('#search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; renderTable(); });
$('#kind-filter').addEventListener('change', (e) => { state.kind = e.target.value; state.page = 1; renderTable(); });
$('#prev-page').addEventListener('click', () => { state.page--; renderTable(); });
$('#next-page').addEventListener('click', () => { state.page++; renderTable(); });
$('#export').addEventListener('click', exportCsv);
document.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => {
  if (state.sort === button.dataset.sort) state.direction *= -1;
  else { state.sort = button.dataset.sort; state.direction = -1; }
  renderTable();
}));
$('#session-rows').addEventListener('click', (e) => {
  const button = e.target.closest('[data-row]');
  const session = button ? state.visibleRows[Number(button.dataset.row)] : null;
  if (!session) return;
  state.dialogId = session.id; renderDialog(state.dialogId); $('#session-dialog').showModal();
});
$('#session-detail').addEventListener('click', (e) => {
  if (!e.target.closest('[data-parent]')) return;
  const source = state.data.sessions.find((s) => s.id === state.dialogId);
  if (source?.parentId && state.data.sessions.some((s) => s.id === source.parentId)) { state.dialogId = source.parentId; renderDialog(state.dialogId); }
});
$('#close-dialog').addEventListener('click', () => $('#session-dialog').close());
$('#session-dialog').addEventListener('close', () => { state.dialogId = null; $('#session-detail').replaceChildren(); });
$('#pricing-button').addEventListener('click', () => { state.pricingDraft = normalizePricing(state.pricing); renderPricing(); $('#pricing-dialog').showModal(); });
$('#pricing-currency').addEventListener('change', (event) => { const currency = event.target.value; if (!capturePricing()) { event.target.value = state.pricingDraft.currency; return; } state.pricingDraft.currency = currency; renderPricing(); });
$('#clear-pricing').addEventListener('click', () => { state.pricingDraft.tables[state.pricingDraft.currency] = {}; renderPricing(); });
$('#pricing-form').addEventListener('submit', (event) => { event.preventDefault(); if (!capturePricing()) return; state.pricing = normalizePricing(state.pricingDraft); savePreferences(); $('#pricing-dialog').close(); render(); });
for (const selector of ['#close-pricing', '#cancel-pricing']) $(selector).addEventListener('click', () => $('#pricing-dialog').close());
$('#pricing-dialog').addEventListener('close', () => { state.pricingDraft = null; state.pricingModels = []; $('#pricing-rows').replaceChildren(); });
for (const dialog of [$('#session-dialog'), $('#pricing-dialog')]) dialog.addEventListener('click', (e) => { if (e.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); });
$('#usage-chart').addEventListener('mousemove', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const bar = state.chartBars.find((b) => x >= b.x && x < b.x + b.width);
  const tip = $('#chart-tooltip');
  if (!bar) { tip.hidden = true; return; }
  const day = bar.day;
  const label = state.chartMode === 'hour' ? `${day.date} ${day.label}` : day.date === day.endDate ? day.date : `${day.date} 至 ${day.endDate}`;
  tip.innerHTML = `<strong>${label}</strong><br>输入 ${fmt(day.input)}<br>缓存 ${fmt(day.cached)}<br>输出 ${fmt(day.output)}<br><strong>合计 ${fmt(day.total)}</strong>${bar.previous ? `<br>对比期 ${fmt(bar.previous.total)}` : ''}`;
  tip.hidden = false;
  tip.style.left = `${Math.max(0, Math.min(x + 12, rect.width - tip.offsetWidth))}px`;
  tip.style.top = '8px';
});
$('#usage-chart').addEventListener('mouseleave', () => { $('#chart-tooltip').hidden = true; });
new ResizeObserver(drawChart).observe($('.chart-container'));
loadPreferences(); renderPrivacy(); icons(); refresh();
setInterval(() => { if ($('#auto-refresh').checked && !document.hidden) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#auto-refresh').checked) refresh(); });
