import { METRICS, selectModels, sum, comparison, historySegments } from './metrics.mjs';

const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('en-US');
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const colors = { 'Stage 1': '#237b63', 'Stage 2': '#5f9fd1', DFlash: '#c6a566', Other: '#8e91a3' };
const groupClass = { 'Stage 1': 'stage1', 'Stage 2': 'stage2', DFlash: 'dflash', Other: 'other' };
const state = { snapshot: null, history: null, baseline: null, group: 'all', metric: 'all', range: '30', query: '', sort: 'downloadsAllTime', busy: false };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const modelIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9v9M4 7.5l8 4.5 8-4.5m-12-7 8 4.5"/></svg>';
const number = value => format.format(value);

async function readJSON(file) {
  const response = await fetch(`./data/${file}?v=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.json();
}

function validate(snapshot) {
  if (snapshot.schemaVersion !== 1 || !snapshot.complete || !Array.isArray(snapshot.models) || !snapshot.models.length || !snapshot.collection || !snapshot.totals || !Array.isArray(snapshot.groups) || !Number.isFinite(Date.parse(snapshot.generatedAt))) throw new Error('快照格式不完整');
  const seen = new Set();
  for (const model of snapshot.models) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model.id) || seen.has(model.id)) throw new Error('模型 ID 无效或重复');
    seen.add(model.id);
    for (const key of ['downloadsAllTime', 'downloads30d', 'likes']) if (!Number.isSafeInteger(model[key]) || model[key] < 0) throw new Error('模型统计缺失');
  }
  for (const key of ['downloadsAllTime', 'downloads30d', 'likes']) if (sum(snapshot.models, key) !== snapshot.totals[key]) throw new Error('快照汇总校验失败');
  if (seen.size !== snapshot.collection.modelCount) throw new Error('模型覆盖数量不一致');
}

async function load() {
  if (state.busy) return;
  state.busy = true;
  $('refresh').disabled = true;
  $('refresh').querySelector('span').textContent = '正在读取…';
  $('error').hidden = true;
  try {
    const results = await Promise.allSettled([readJSON('latest.json'), readJSON('history.json'), readJSON('baseline.json')]);
    if (results[0].status !== 'fulfilled') throw results[0].reason;
    const snapshot = results[0].value;
    validate(snapshot);
    state.snapshot = snapshot;
    state.history = results[1].status === 'fulfilled' && Array.isArray(results[1].value.points) ? results[1].value : null;
    state.baseline = results[2].status === 'fulfilled' ? results[2].value : null;
    renderSummary();
    renderFilters();
    renderCharts();
    renderTable();
    $('summary').setAttribute('aria-busy', 'false');
  } catch (error) {
    $('error').textContent = state.snapshot ? `刷新失败，继续显示上次成功读取的完整快照。${error.message}` : `暂时无法读取统计数据，请稍后刷新或查看页面底部的采集状态。${error.message}`;
    $('error').hidden = false;
    if (!state.snapshot) {
      $('update-status').textContent = '数据加载失败';
      $('model-rows').innerHTML = '<tr><td colspan="7" class="empty-row">暂时没有可显示的快照</td></tr>';
      $('history-chart').innerHTML = '<div class="chart-loading">历史数据暂不可用</div>';
    }
  } finally {
    state.busy = false;
    $('refresh').disabled = false;
    $('refresh').querySelector('span').textContent = '刷新快照';
  }
}

function renderSummary() {
  const s = state.snapshot;
  $('all-time').textContent = number(s.totals.downloadsAllTime);
  $('last-month').textContent = number(s.totals.downloads30d);
  $('model-count').textContent = number(s.models.length);
  $('likes').textContent = number(s.totals.likes);
  $('total-scope').textContent = `${s.models.length} 个模型合计 · Hub 计数`;
  $('coverage').textContent = `${s.models.length} / ${s.collection.modelCount} 个模型采集成功`;
  const stale = Date.now() - Date.parse(s.generatedAt) > 18 * 60 * 60 * 1000;
  $('update-status').textContent = `${stale ? '快照超过 18 小时未更新，请检查采集状态 · ' : '最近采集 · '}${dateFormat.format(new Date(s.generatedAt))}`;
  $('status-dot').className = `status-indicator ${stale ? 'stale' : 'fresh'}`;
}

function renderFilters() {
  const groups = ['Stage 1', 'Stage 2', 'DFlash', 'Other'].filter(group => state.snapshot.models.some(m => m.group === group));
  if (!groups.includes(state.group)) state.group = 'all';
  $('filters').innerHTML = [['all', '全部模型'], ...groups.map(group => [group, group])].map(([group, label]) => `<button type="button" data-group="${escape(group)}" aria-pressed="${state.group === group}">${escape(label)}</button>`).join('');
}

function filteredModels() { return selectModels(state.snapshot.models, state); }

function renderTable() {
  const rows = filteredModels();
  const total = state.snapshot.totals.downloadsAllTime;
  $('table-count').textContent = `${rows.length} 个模型`;
  $('model-rows').innerHTML = rows.length ? rows.map((m, i) => {
    const percent = total ? m.downloadsAllTime / total * 100 : 0;
    const url = `https://huggingface.co/${m.id}`;
    return `<tr><td class="rank">${String(i + 1).padStart(2, '0')}</td><td><a class="model-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="${escape(m.id)}"><span class="model-symbol">${modelIcon}</span><span><span class="model-label">${escape(m.label)}<span class="out-arrow" aria-hidden="true">↗</span></span><span class="model-repo">${escape(m.id)}</span></span></a></td><td><span class="stage-badge ${groupClass[m.group] ?? 'other'}">${escape(m.group)}</span></td><td class="numeric"><strong>${number(m.downloadsAllTime)}</strong></td><td class="numeric">${number(m.downloads30d)}</td><td class="numeric likes-column">${number(m.likes)}</td><td class="share-column"><div class="share-cell"><div class="share-track" aria-hidden="true"><span style="width:${percent}%"></span></div><span>${percent.toFixed(1)}%</span></div></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty-row">没有匹配的模型，试试其他关键词或阶段。</td></tr>';
  $('table-footer').innerHTML = `<span>显示 ${rows.length} / ${state.snapshot.models.length} 个模型 · 占比基于全部模型累计下载</span><strong>当前筛选合计 ${number(sum(rows, 'downloadsAllTime'))} 次累计 · ${number(sum(rows, 'downloads30d'))} 次近 30 天</strong>`;
}

function renderCharts() {
  const metric = METRICS[state.metric];
  const total = state.snapshot.totals[metric];
  const groups = ['Stage 1', 'Stage 2', 'DFlash', 'Other'].map(name => state.snapshot.groups.find(g => g.name === name)).filter(Boolean);
  let offset = 0;
  const segments = groups.map(group => {
    const start = offset;
    offset += total ? group[metric] / total * 100 : 0;
    return `${colors[group.name] ?? colors.Other} ${start}% ${offset}%`;
  });
  $('donut').style.background = total ? `conic-gradient(${segments.join(',')})` : '#e6eeea';
  $('donut').setAttribute('aria-label', groups.map(g => `${g.name} ${number(g[metric])} 次`).join('，'));
  $('donut-total').textContent = number(total);
  $('donut-label').textContent = state.metric === 'all' ? '累计下载' : '近 30 天下载';
  $('chart-metric').textContent = state.metric === 'all' ? '累计下载量' : '近 30 天下载量';
  $('distribution-caption').textContent = state.metric === 'all' ? '各阶段累计下载量占比' : '各阶段近 30 天下载量占比';
  $('group-count').textContent = `${groups.length} 组`;
  $('group-legend').innerHTML = groups.map(g => `<div class="group-row"><span class="group-swatch" style="background:${colors[g.name] ?? colors.Other}"></span><span class="group-name">${escape(g.name)}</span><span class="group-count">${g.modelCount} 模型</span><span class="group-value">${number(g[metric])}</span><span class="group-share">${(total ? g[metric] / total * 100 : 0).toFixed(1)}%</span></div>`).join('');
  const leader = selectModels(state.snapshot.models, { sort: metric })[0];
  $('leading-model').innerHTML = `当前领先 <strong>${escape(leader.label)}</strong> · ${number(leader[metric])} 次`;
  renderHistory();
}

function renderHistory() {
  if (!state.history) {
    $('history-chart').innerHTML = '<div class="chart-loading">历史文件暂不可用，模型统计已正常加载</div>';
    $('history-note').textContent = '请稍后刷新历史快照';
    return;
  }
  const metric = METRICS[state.metric];
  let points = [...state.history.points].sort((a, b) => a.date.localeCompare(b.date));
  const lastDay = points.length ? Date.parse(`${points.at(-1).date}T00:00:00Z`) : Date.now();
  if (state.range !== 'all') points = points.filter(p => Date.parse(`${p.date}T00:00:00Z`) >= lastDay - (Number(state.range) - 1) * 86400000);
  if (!points.length) {
    $('history-chart').innerHTML = '<div class="chart-loading">所选范围内还没有历史观测</div>';
    $('history-note').textContent = '采集成功后自动生成趋势';
    return;
  }
  const width = Math.max(280, $('history-chart').clientWidth - 30);
  const height = $('history-chart').clientHeight || 242;
  const left = 52, right = width - 15, top = 26, bottom = height - 36;
  const values = points.map(p => p.totals[metric]);
  const maximum = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const ceiling = Math.ceil(maximum * 1.18 / magnitude) * magnitude;
  const firstTime = Date.parse(`${points[0].date}T00:00:00Z`);
  const lastTime = Date.parse(`${points.at(-1).date}T00:00:00Z`);
  const x = p => lastTime === firstTime ? (left + right) / 2 : left + (Date.parse(`${p.date}T00:00:00Z`) - firstTime) / (lastTime - firstTime) * (right - left);
  const y = value => bottom - value / ceiling * (bottom - top);
  let chart = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-desc"><title id="trend-title">${state.metric === 'all' ? '累计下载量' : '近 30 天下载量'}历史观测</title><desc id="trend-desc">${points.map(p => `${p.date}: ${number(p.totals[metric])} 次，${p.modelCount} 个模型`).join('；')}</desc>`;
  for (let i = 0; i <= 4; i++) {
    const value = ceiling * i / 4, axisY = y(value);
    chart += `<line x1="${left}" x2="${right}" y1="${axisY}" y2="${axisY}" stroke="#e8eeea" stroke-width="1" ${i ? 'stroke-dasharray="3 5"' : ''}/><text x="${left - 12}" y="${axisY + 4}" fill="#98a59b" font-size="11" text-anchor="end">${number(value)}</text>`;
  }
  for (const segment of historySegments(points)) {
    if (segment.length > 1) chart += `<polyline points="${segment.map(p => `${x(p)},${y(p.totals[metric])}`).join(' ')}" fill="none" stroke="#237b63" stroke-width="2.5"/>`;
    for (const p of segment) chart += `<circle cx="${x(p)}" cy="${y(p.totals[metric])}" r="4" fill="#237b63" stroke="#fff" stroke-width="2"><title>${escape(p.date)} · ${number(p.totals[metric])} 次 · ${p.modelCount} 模型</title></circle>`;
  }
  const tickIndices = new Set([0, points.length - 1, ...Array.from({ length: Math.min(5, points.length) }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, Math.min(5, points.length) - 1)))]);
  for (const i of tickIndices) {
    const p = points[i];
    chart += `<text x="${x(p)}" y="${height - 12}" fill="#92a095" font-size="11" text-anchor="middle">${escape(p.date.slice(5).replace('-', '/'))}</text>`;
  }
  if (points.length === 1) {
    const p = points[0];
    chart += `<circle cx="${x(p)}" cy="${y(p.totals[metric])}" r="11" fill="#237b63" fill-opacity=".09"/><text x="${x(p)}" y="${y(p.totals[metric]) - 18}" text-anchor="middle" fill="#1c6048" font-size="15" font-weight="600" class="history-data-label">${number(p.totals[metric])}</text><text x="${x(p)}" y="${Math.max(y(p.totals[metric]) + 40, 146)}" text-anchor="middle" fill="#758b7b" font-size="12">首个观测已记录 · 后续日期将形成趋势</text>`;
  }
  chart += '</svg>';
  $('history-chart').innerHTML = chart;
  const delta = comparison(state.snapshot, state.baseline);
  const membershipChanges = historySegments(points).length > 1;
  $('history-note').textContent = membershipChanges ? `${points.length} 个观测日 · 模型成员变化处已断线` : state.metric === 'month' ? `${points.length} 个观测日 · 每点为滚动 30 天计数，非当日新增` : `${points.length} 个观测日 · ${delta === null ? '模型成员已变化，不计算整体增量' : `较首次快照 ${delta >= 0 ? '+' : ''}${number(delta)} 次`}`;
}

$('refresh').addEventListener('click', load);
$('search').addEventListener('input', event => { state.query = event.target.value; if (state.snapshot) renderTable(); });
$('sort').addEventListener('change', event => { state.sort = event.target.value; if (state.snapshot) renderTable(); });
$('filters').addEventListener('click', event => {
  const button = event.target.closest('button[data-group]');
  if (!button || !state.snapshot) return;
  state.group = button.dataset.group;
  renderFilters(); renderTable();
});
document.querySelector('.segmented').addEventListener('click', event => {
  const button = event.target.closest('button[data-metric]');
  if (!button || !state.snapshot) return;
  state.metric = button.dataset.metric;
  document.querySelectorAll('[data-metric]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderCharts();
});
$('range').addEventListener('change', event => { state.range = event.target.value; if (state.snapshot) renderHistory(); });
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
}));
let chartWidth = 0;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (width !== chartWidth) {
    chartWidth = width;
    if (state.snapshot) renderHistory();
  }
}).observe($('history-chart'));
load();
