const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat('zh-CN');
const state = { data: null, days: 7, period: 'today', search: '', kind: 'all', sort: 'total', direction: -1, page: 1, busy: false, chartBars: [], dialogId: null };
const pageSize = 15;
const colors = ['#16846a', '#6d9fd7', '#e6a049'];
const zero = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
const fmt = (n) => number.format(Number(n) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const compact = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : String(Math.round(n));
const icons = () => window.lucide?.createIcons();
const counters = (s) => state.period === 'today' ? { ...zero, ...s.today } : { ...zero, ...s };
const child = (s) => s.kind === 'subagent';
const projectName = (s) => (s.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '未命名项目';
const sessionName = (s) => s.title && s.title !== s.id && s.title !== s.id.slice(0, 8) ? s.title : `${child(s) ? '子代理' : '会话'} ${s.id.slice(-8)}`;
const time = (v, full = false) => v && !Number.isNaN(Date.parse(v)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: state.data?.timezone || 'Asia/Shanghai', ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: full ? undefined : '2-digit', hour12: false }).format(new Date(v)) : '--';

function filteredSessions() {
  const query = state.search.trim().toLowerCase();
  return (state.data?.sessions || []).filter((s) => {
    if (state.period === 'today' && !(s.today?.total > 0)) return false;
    if (state.kind === 'main' && child(s)) return false;
    if (state.kind === 'subagent' && !child(s)) return false;
    return !query || [s.id, s.parentId, s.title, s.cwd, s.model].some((v) => String(v || '').toLowerCase().includes(query));
  }).sort((a, b) => {
    const x = state.sort === 'updatedAt' ? Date.parse(a.updatedAt) || 0 : counters(a)[state.sort] || 0;
    const y = state.sort === 'updatedAt' ? Date.parse(b.updatedAt) || 0 : counters(b)[state.sort] || 0;
    return state.direction * (x - y) || a.id.localeCompare(b.id);
  });
}

function render() {
  const data = state.data;
  if (!data) return;
  const today = { ...zero, ...data.today };
  const total = { ...zero, ...data.totals };
  const active = data.sessions.filter((s) => s.today?.total > 0);
  const children = active.filter(child).length;
  $('#today-total').textContent = fmt(today.total);
  $('#all-total').textContent = fmt(total.total);
  $('#today-split').textContent = `输入 ${compact(today.input)} / 输出 ${compact(today.output)}`;
  $('#all-sessions').textContent = `${fmt(data.sessions.length)} 个本地会话`;
  $('#cache-rate').textContent = today.input ? `${(today.cached / today.input * 100).toFixed(1)}%` : '--';
  $('#cached-total').textContent = `${fmt(today.cached)} 缓存输入 Token`;
  $('#active-sessions').textContent = fmt(active.length);
  $('#active-split').textContent = `主会话 ${active.length - children} / 子代理 ${children}`;
  $('#uncached-value').textContent = fmt(Math.max(0, today.input - today.cached));
  $('#cached-value').textContent = fmt(today.cached);
  $('#output-value').textContent = fmt(today.output);
  $('#reasoning-value').textContent = fmt(today.reasoning);
  const parts = [Math.max(0, today.input - today.cached), today.cached, today.output];
  $('#composition-bar').replaceChildren(...parts.map((n, i) => {
    const segment = document.createElement('span');
    segment.style.width = `${today.total ? n / today.total * 100 : 0}%`;
    segment.style.background = colors[i];
    return segment;
  }));
  $('#current-date').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: data.timezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(data.generatedAt));
  $('#updated-at').textContent = `更新于 ${time(data.generatedAt)}`;
  $('#timezone').textContent = data.timezone || 'Asia/Shanghai';
  $('#coverage-range').textContent = `${fmt(data.coverage?.files || 0)} 份日志 · ${data.timezone || 'Asia/Shanghai'}`;
  const warnings = data.coverage?.warnings || [];
  $('#warning').hidden = !warnings.length;
  $('#warning').textContent = warnings.map((w) => typeof w === 'string' ? w : w.message || JSON.stringify(w)).join('；');
  drawChart();
  renderTable();
  if (state.dialogId) renderDialog(state.dialogId);
}

function renderTable() {
  const rows = filteredSessions();
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * pageSize;
  $('#session-count').textContent = fmt(rows.length);
  $('#session-rows').innerHTML = rows.slice(start, start + pageSize).map((s) => {
    const count = counters(s);
    return `<tr><td><button class="session-link" data-session="${esc(s.id)}" title="查看会话详情"><span class="session-icon"><i data-lucide="${child(s) ? 'git-branch' : 'message-square'}"></i></span><span class="session-text"><span class="session-name">${esc(sessionName(s))}</span><span class="session-project" title="${esc(s.cwd)}">${esc(projectName(s))}${child(s) ? ' · 子代理' : ''}</span></span></button></td><td class="model">${esc(s.model || '未记录')}</td><td class="numeric">${fmt(count.input)}</td><td class="numeric cached-cell">${fmt(count.cached)}</td><td class="numeric">${fmt(count.output)}</td><td class="numeric total-cell">${fmt(count.total)}</td><td class="numeric time-cell" title="${esc(s.updatedAt)}">${time(s.updatedAt, true)}</td></tr>`;
  }).join('');
  $('#empty-state').hidden = rows.length > 0;
  $('#table-summary').textContent = rows.length ? `${start + 1}–${Math.min(start + pageSize, rows.length)} / ${rows.length} 个会话 · 合计 ${fmt(rows.reduce((sum, s) => sum + counters(s).total, 0))} Token` : '0 个会话';
  $('#page-label').textContent = `${state.page} / ${pages}`;
  $('#prev-page').disabled = state.page <= 1;
  $('#next-page').disabled = state.page >= pages;
  $('#export').disabled = rows.length === 0;
  document.querySelectorAll('[data-sort]').forEach((b) => {
    const selected = state.sort === b.dataset.sort;
    b.closest('th').removeAttribute('aria-sort');
    if (selected) b.closest('th').setAttribute('aria-sort', state.direction > 0 ? 'ascending' : 'descending');
    b.querySelector('svg, i')?.remove();
    b.insertAdjacentHTML('beforeend', `<i data-lucide="${selected ? state.direction > 0 ? 'arrow-up' : 'arrow-down' : 'chevrons-up-down'}"></i>`);
  });
  icons();
}

function selectedDays() {
  const map = new Map((state.data?.days || []).map((d) => [d.date, d]));
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: state.data?.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(state.data?.generatedAt || Date.now()));
  const part = (name) => parts.find((p) => p.type === name).value;
  const end = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
  return Array.from({ length: state.days }, (_, i) => {
    const date = new Date(end.getTime() - (state.days - 1 - i) * 86400000).toISOString().slice(0, 10);
    return { ...zero, date, ...map.get(date) };
  });
}

function drawChart() {
  const canvas = $('#usage-chart');
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const days = selectedDays();
  $('#trend-total').textContent = `${fmt(days.reduce((sum, d) => sum + d.total, 0))} Token`;
  const maximum = Math.max(...days.map((d) => d.total), 1);
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const ymax = Math.ceil(maximum / magnitude) * magnitude;
  const pad = { left: 45, right: 8, top: 15, bottom: 32 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const cellWidth = plotWidth / days.length;
  const barWidth = Math.min(state.days === 7 ? 44 : 17, cellWidth * .62);
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
  state.chartBars = days.map((day, i) => {
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
    if (state.days === 7 || i % (width < 450 ? 7 : 5) === 0 || i === days.length - 1) {
      ctx.fillStyle = i === days.length - 1 ? '#337355' : '#85948a';
      ctx.textAlign = 'center';
      ctx.fillText(day.date.slice(5).replace('-', '/'), x + barWidth / 2, height - 10);
    }
    return { x: pad.left + cellWidth * i, width: cellWidth, day };
  });
  canvas.setAttribute('aria-label', `最近 ${state.days} 天每日 Token 用量，合计 ${fmt(days.reduce((sum, d) => sum + d.total, 0))}。${days.filter((d) => d.total).map((d) => `${d.date}: ${fmt(d.total)}`).join('；')}`);
}

function renderDialog(id) {
  const s = state.data.sessions.find((row) => row.id === id);
  if (!s) return;
  const count = { ...zero, ...s };
  const today = { ...zero, ...s.today };
  const fields = [['input', '输入'], ['cached', '其中：缓存输入'], ['cacheWrite', '缓存写入'], ['output', '输出'], ['reasoning', '其中：推理输出'], ['total', '合计']];
  $('#session-detail').innerHTML = `<div class="detail-meta"><b>${esc(sessionName(s))}</b><br>${esc(s.id)}<br><br>类型：${child(s) ? '子代理' : '主会话'}<br>模型：${esc(s.model || '未记录')}<br>项目：${esc(s.cwd || '未记录')}<br>最近活动：${esc(s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { timeZone: state.data.timezone, hour12: false }) : '--')}</div><table class="detail-stats"><thead><tr><th>Token</th><th>今日</th><th>累计</th></tr></thead><tbody>${fields.map(([field, name]) => `<tr><td>${name}</td><td>${fmt(today[field])}</td><td>${fmt(count[field])}</td></tr>`).join('')}</tbody></table>${s.parentId ? `<button class="detail-parent" data-parent="${esc(s.parentId)}"><i data-lucide="corner-up-left"></i>查看所属会话</button>` : ''}`;
  icons();
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
    $('#loading').hidden = true;
    $('#error').hidden = true;
    $('#status-dot').className = 'status-dot ready';
    $('#connection-status').textContent = $('#auto-refresh').checked ? '本地 · 已连接' : '本地 · 已暂停';
    render();
  } catch (error) {
    $('#loading').hidden = true;
    $('#error').hidden = false;
    $('#error').textContent = `暂时无法读取用量数据${state.data ? '，当前保留上次结果' : ''}。${error.name === 'TimeoutError' ? '读取超时' : error.message}`;
    $('#status-dot').className = 'status-dot failed';
    $('#connection-status').textContent = '连接中断';
  } finally {
    state.busy = false;
    $('#refresh').disabled = false;
    $('#refresh').querySelector('svg')?.classList.remove('spin');
  }
}

function exportCsv() {
  const rows = filteredSessions();
  const header = ['会话 ID', '父会话 ID', '类型', '项目', '模型', '统计范围', '输入 Token', '缓存输入 Token', '缓存写入 Token', '输出 Token', '推理输出 Token', '总 Token', '最近活动'];
  const values = rows.map((s) => { const c = counters(s); return [s.id, s.parentId || '', child(s) ? '子代理' : '主会话', s.cwd, s.model, state.period === 'today' ? '今日' : '累计', c.input, c.cached, c.cacheWrite, c.output, c.reasoning, c.total, s.updatedAt]; });
  const cell = (v) => { let text = String(v ?? ''); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };
  const csv = '\uFEFF' + [header, ...values].map((row) => row.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `codex-tokens-${state.period}-${selectedDays().at(-1).date}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#refresh').addEventListener('click', refresh);
$('#auto-refresh').addEventListener('change', () => { if ($('#auto-refresh').checked) refresh(); else $('#connection-status').textContent = '本地 · 已暂停'; });
$('#search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; renderTable(); });
$('#kind-filter').addEventListener('change', (e) => { state.kind = e.target.value; state.page = 1; renderTable(); });
$('#prev-page').addEventListener('click', () => { state.page--; renderTable(); });
$('#next-page').addEventListener('click', () => { state.page++; renderTable(); });
$('#export').addEventListener('click', exportCsv);
document.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => {
  state.days = Number(button.dataset.days);
  document.querySelectorAll('[data-days]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  $('#chart-tooltip').hidden = true;
  drawChart();
}));
document.querySelectorAll('[data-period]').forEach((button) => button.addEventListener('click', () => {
  state.period = button.dataset.period; state.page = 1;
  document.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  renderTable();
}));
document.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => {
  if (state.sort === button.dataset.sort) state.direction *= -1;
  else { state.sort = button.dataset.sort; state.direction = -1; }
  renderTable();
}));
$('#session-rows').addEventListener('click', (e) => {
  const button = e.target.closest('[data-session]');
  if (!button) return;
  state.dialogId = button.dataset.session;
  renderDialog(state.dialogId);
  $('#session-dialog').showModal();
});
$('#session-detail').addEventListener('click', (e) => {
  const button = e.target.closest('[data-parent]');
  if (!button) return;
  if (state.data.sessions.some((s) => s.id === button.dataset.parent)) {
    state.dialogId = button.dataset.parent; renderDialog(state.dialogId);
  } else {
    state.search = button.dataset.parent; state.period = 'all'; state.kind = 'all'; state.page = 1;
    $('#search').value = state.search; $('#kind-filter').value = 'all';
    document.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === 'all')));
    $('#session-dialog').close(); renderTable();
  }
});
$('#close-dialog').addEventListener('click', () => $('#session-dialog').close());
$('#session-dialog').addEventListener('close', () => { state.dialogId = null; });
$('#session-dialog').addEventListener('click', (e) => { if (e.target === $('#session-dialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
$('#usage-chart').addEventListener('mousemove', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const bar = state.chartBars.find((b) => x >= b.x && x < b.x + b.width);
  const tip = $('#chart-tooltip');
  if (!bar) { tip.hidden = true; return; }
  tip.innerHTML = `<strong>${bar.day.date}</strong><br>输入 ${fmt(bar.day.input)}<br>缓存 ${fmt(bar.day.cached)}<br>输出 ${fmt(bar.day.output)}<br><strong>合计 ${fmt(bar.day.total)}</strong>`;
  tip.hidden = false;
  tip.style.left = `${Math.max(0, Math.min(x + 12, rect.width - tip.offsetWidth))}px`;
  tip.style.top = '8px';
});
$('#usage-chart').addEventListener('mouseleave', () => { $('#chart-tooltip').hidden = true; });
new ResizeObserver(drawChart).observe($('.chart-container'));
icons();
refresh();
setInterval(() => { if ($('#auto-refresh').checked && !document.hidden) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#auto-refresh').checked) refresh(); });
