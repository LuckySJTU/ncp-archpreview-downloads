import { SOURCES, combinedDownloads, validate, selectModels, sum, comparison, historySegments } from './metrics.mjs';

const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('en-US');
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const colors = { 'Stage 1': '#237b63', 'Stage 2': '#5f9fd1', DFlash: '#c6a566', Other: '#8e91a3' };
const groupClass = { 'Stage 1': 'stage1', 'Stage 2': 'stage2', DFlash: 'dflash', Other: 'other' };
const requestedSource = new URL(location.href).searchParams.get('source');
const state = { sources: {}, provider: Object.hasOwn(SOURCES, requestedSource) ? requestedSource : 'huggingface', snapshot: null, history: null, baseline: null, group: 'all', metric: 'all', range: '30', query: '', sort: 'downloadsAllTime', busy: false };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const modelIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9v9M4 7.5l8 4.5 8-4.5m-12-7 8 4.5"/></svg>';
const number = value => value == null ? '—' : format.format(value);
const source = () => SOURCES[state.provider];
const metricKey = () => state.metric === 'month' ? 'downloads30d' : source().primary;
const metricLabel = () => state.metric === 'month' ? '近 30 天下载' : source().label;

async function readJSON(file) {
  const response = await fetch(`./data/${file}?v=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.json();
}

async function readSource(provider) {
  const path = SOURCES[provider].directory;
  const results = await Promise.allSettled(['latest.json', 'history.json', 'baseline.json', 'status.json'].map(file => readJSON(path + file)));
  if (results[0].status !== 'fulfilled') throw results[0].reason;
  const snapshot = results[0].value;
  validate(snapshot, provider);
  let baseline = results[2].status === 'fulfilled' ? results[2].value : null;
  try { validate(baseline, provider); } catch { baseline = null; }
  const history = results[1].status === 'fulfilled' ? results[1].value : null;
  const historyValid = Array.isArray(history?.points) && history.points.every(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(Date.parse(point.date)) && typeof point.membershipHash === 'string' && Number.isSafeInteger(point.modelCount) && SOURCES[provider].fields.every(key => Number.isSafeInteger(point.totals?.[key]) && point.totals[key] >= 0));
  return {
    snapshot,
    history: historyValid ? history : null,
    baseline,
    status: results[3].status === 'fulfilled' ? results[3].value : null,
  };
}

async function load() {
  if (state.busy) return;
  state.busy = true;
  $('refresh').disabled = true;
  $('refresh').querySelector('span').textContent = '正在读取…';
  $('error').hidden = true;
  try {
    const providers = Object.keys(SOURCES);
    const results = await Promise.allSettled(providers.map(readSource));
    results.forEach((result, i) => {
      const provider = providers[i];
      state.sources[provider] = result.status === 'fulfilled' ? result.value : { ...state.sources[provider], error: result.reason.message };
    });
    showSource();
  } finally {
    state.busy = false;
    $('refresh').disabled = false;
    $('refresh').querySelector('span').textContent = '刷新快照';
  }
}

function showSource() {
  const snapshots = Object.fromEntries(Object.entries(state.sources).map(([id, data]) => [id, data.snapshot]));
  const grandTotal = combinedDownloads(snapshots);
  $('grand-total').textContent = number(grandTotal);
  $('combined-formula').textContent = grandTotal === null ? '等待两个平台的完整快照' : `Hugging Face ${number(snapshots.huggingface.totals.downloadsAllTime)} + 魔搭 ${number(snapshots.modelscope.totals.platformDownloads)}`;
  const outdated = Object.entries(state.sources).filter(([, data]) => data.error || data.status?.ok === false || (data.snapshot && Date.now() - Date.parse(data.snapshot.generatedAt) > 18 * 3600000)).map(([id]) => SOURCES[id].name);
  $('combined-freshness').textContent = grandTotal === null ? '有平台数据不可用，暂不显示不完整合计' : outdated.length ? `${outdated.join('、')} 使用上次完整快照，合计含历史数据` : '按两个平台最近的完整快照合计';
  $('combined-freshness').classList.toggle('combined-warning', grandTotal === null || outdated.length > 0);
  const selected = state.sources[state.provider] ?? {};
  state.snapshot = selected.snapshot ?? null;
  state.history = selected.history ?? null;
  state.baseline = selected.baseline ?? null;
  const config = source(), isMS = state.provider === 'modelscope';
  if (isMS) state.metric = 'all';
  if (![...config.fields, 'name'].includes(state.sort)) state.sort = config.primary;
  document.body.dataset.source = state.provider;
  for (const [id, details] of Object.entries(SOURCES)) {
    const data = state.sources[id];
    const button = $('sources').querySelector(`button[data-source="${id}"]`);
    button.setAttribute('aria-pressed', String(id === state.provider));
    button.querySelector('.source-total').textContent = number(data?.snapshot?.totals[details.primary]);
    const stale = data?.snapshot && Date.now() - Date.parse(data.snapshot.generatedAt) > 18 * 3600000;
    button.querySelector('.source-caption').textContent = data?.snapshot ? `${data.snapshot.models.length} 个模型${data.snapshot.pendingModels?.length ? ` · ${data.snapshot.pendingModels.length} 待上线` : ''} · ${details.label}${data.error || data.status?.ok === false || stale ? ' · 待更新' : ''}` : '暂未取得完整快照';
  }
  $('primary-label').textContent = isMS ? '平台下载量' : '累计下载量';
  $('primary-tag').textContent = isMS ? 'MODELSCOPE' : 'ALL TIME';
  $('month-note').textContent = isMS ? '公开接口未提供此窗口' : '滚动 30 天窗口';
  $('likes-label').textContent = `模型${config.likes}`;
  $('likes-note').textContent = isMS ? '各模型 Stars 加总' : '各模型 Likes 加总';
  $('active-source').textContent = `${config.name} · ${isMS ? '采用公开 Downloads 计数，统计窗口未明确' : '累计与近 30 天分别统计'}`;
  $('primary-heading').textContent = config.label;
  $('likes-heading').textContent = config.likes;
  $('share-heading').textContent = isMS ? '下载占比' : '累计占比';
  $('table-caption').textContent = `${config.name} 模型统计；待上线模型不计为零；点击模型名称打开对应平台页面`;
  $('models-title').textContent = `${config.name} · 模型明细`;
  $('sort').innerHTML = `<option value="${config.primary}">${config.label} ↓</option>${isMS ? '' : '<option value="downloads30d">近 30 天 ↓</option>'}<option value="likes">${config.likes}数 ↓</option><option value="name">模型名称 ↑</option>`;
  $('sort').value = state.sort;
  document.querySelector('[data-metric="all"]').textContent = isMS ? '平台计数' : '累计';
  document.querySelector('[data-metric="month"]').disabled = isMS;
  document.querySelector('[data-metric="month"]').title = isMS ? '魔搭公开接口未提供近 30 天下载量' : '';
  document.querySelectorAll('[data-metric]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.metric === state.metric)));
  $('export').href = `./data/${config.directory}models.csv`;
  $('export').download = `ncp-archpreview-${state.provider}-models.csv`;
  $('history-link').href = `./data/${config.directory}history.json`;
  $('snapshot-link').href = `./data/${config.directory}latest.json`;
  $('source-link').href = isMS ? 'https://www.modelscope.cn/collections/Shanghai_AI_Laboratory/NCP_ArchPreview' : 'https://huggingface.co/collections/ArchSpace-Collection/ncp-archpreview';
  $('source-link').textContent = `${config.name} Collection ↗`;
  $('error').hidden = !selected.error && selected.status?.ok !== false;
  $('error').textContent = `${config.name} 最近一次${selected.error ? '读取' : '采集'}失败，${state.snapshot ? '保留上次完整快照，时间见下方。' : '暂时没有可用快照。'}可通过页面底部的采集状态查看详情。`;
  $('summary').setAttribute('aria-busy', 'false');
  if (!state.snapshot) {
    for (const id of ['all-time', 'last-month', 'model-count', 'likes', 'donut-total']) $(id).textContent = '—';
    $('total-scope').textContent = '等待完整快照';
    $('coverage').textContent = '尚无可用数据';
    $('update-status').textContent = `${config.name} 数据暂不可用`;
    $('status-dot').className = 'status-indicator stale';
    $('model-rows').innerHTML = '<tr><td colspan="7" class="empty-row">暂时没有可显示的快照</td></tr>';
    $('history-chart').innerHTML = '<div class="chart-loading">历史数据暂不可用</div>';
    $('donut').style.background = '#e6eeea';
    $('group-legend').textContent = '';
    for (const id of ['table-count', 'table-footer', 'history-note', 'leading-model', 'group-count']) $(id).textContent = '暂无数据';
    return;
  }
  renderSummary(); renderFilters(); renderCharts(); renderTable();
}

function renderSummary() {
  const s = state.snapshot;
  $('all-time').textContent = number(s.totals[source().primary]);
  $('last-month').textContent = number(s.totals.downloads30d);
  $('model-count').textContent = number(s.models.length);
  $('likes').textContent = number(s.totals.likes);
  $('total-scope').textContent = `${s.models.length} 个模型合计 · ${source().name}`;
  $('coverage').textContent = `${s.models.length} / ${s.collection.targetCount ?? s.collection.modelCount} 个模型路径可读取${s.pendingModels?.length ? ` · ${s.pendingModels.length} 待上线` : ''}`;
  const stale = Date.now() - Date.parse(s.generatedAt) > 18 * 60 * 60 * 1000;
  const failed = state.sources[state.provider]?.status?.ok === false;
  $('update-status').textContent = `${failed ? '最近采集失败 · 上次成功 ' : stale ? '快照超过 18 小时未更新，请检查采集状态 · ' : '最近采集 · '}${dateFormat.format(new Date(s.generatedAt))}`;
  $('status-dot').className = `status-indicator ${stale || failed ? 'stale' : 'fresh'}`;
}

function renderFilters() {
  const groups = ['Stage 1', 'Stage 2', 'DFlash', 'Other'].filter(group => [...state.snapshot.models, ...(state.snapshot.pendingModels ?? [])].some(m => m.group === group));
  if (!groups.includes(state.group)) state.group = 'all';
  $('filters').innerHTML = [['all', '全部模型'], ...groups.map(group => [group, group])].map(([group, label]) => `<button type="button" data-group="${escape(group)}" aria-pressed="${state.group === group}">${escape(label)}</button>`).join('');
}

function filteredModels() { return selectModels([...state.snapshot.models, ...(state.snapshot.pendingModels ?? [])], state); }

function renderTable() {
  const rows = filteredModels();
  const primary = source().primary;
  const total = state.snapshot.totals[primary];
  const available = rows.filter(m => m.status !== 'pending');
  $('table-count').textContent = `${rows.length} 个模型${rows.length !== available.length ? ` · ${rows.length - available.length} 待上线` : ''}`;
  $('model-rows').innerHTML = rows.length ? rows.map((m, i) => {
    const percent = total ? m[primary] / total * 100 : 0;
    const url = source().modelBase + m.id;
    return `<tr><td class="rank">${String(i + 1).padStart(2, '0')}</td><td><a class="model-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="${escape(m.id)}"><span class="model-symbol">${modelIcon}</span><span><span class="model-label">${escape(m.label)}${m.status === 'pending' ? '<span class="pending-badge">待上线</span>' : ''}<span class="out-arrow" aria-hidden="true">↗</span></span><span class="model-repo">${escape(m.id)}</span></span></a></td><td><span class="stage-badge ${groupClass[m.group] ?? 'other'}">${escape(m.group)}</span></td><td class="numeric"><strong>${number(m[primary])}</strong></td><td class="numeric month-column">${number(m.downloads30d)}</td><td class="numeric likes-column">${number(m.likes)}</td><td class="share-column">${m.status === 'pending' ? '<span class="pending-note">尚无公开统计</span>' : `<div class="share-cell"><div class="share-track" aria-hidden="true"><span style="width:${percent}%"></span></div><span>${percent.toFixed(1)}%</span></div>`}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty-row">没有匹配的模型，试试其他关键词或阶段。</td></tr>';
  $('table-footer').innerHTML = `<span>显示 ${rows.length} / ${state.snapshot.collection.targetCount ?? state.snapshot.models.length} 个模型 · 占比基于本平台可读取模型</span><strong>${rows.length && !available.length ? '当前筛选均待上线，暂无下载统计' : `已读取合计 ${number(sum(available, primary))} 次${source().label}${state.provider === 'huggingface' ? ` · ${number(sum(available, 'downloads30d'))} 次近 30 天` : ''}`}</strong>`;
}

function renderCharts() {
  const metric = metricKey();
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
  $('donut-label').textContent = metricLabel();
  $('chart-metric').textContent = metricLabel();
  $('distribution-caption').textContent = `各阶段${metricLabel()}占比`;
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
  const metric = metricKey();
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
  let chart = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-desc"><title id="trend-title">${metricLabel()}历史观测</title><desc id="trend-desc">${points.map(p => `${p.date}: ${number(p.totals[metric])} 次，${p.modelCount} 个模型`).join('；')}</desc>`;
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
  const delta = comparison(state.snapshot, state.baseline, source().primary);
  const membershipChanges = historySegments(points).length > 1;
  $('history-note').textContent = membershipChanges ? `${points.length} 个观测日 · 模型成员变化处已断线` : state.metric === 'month' ? `${points.length} 个观测日 · 每点为滚动 30 天计数，非当日新增` : `${points.length} 个观测日 · ${delta === null ? '基线不可用或模型成员已变化，不计算整体增量' : `较首次快照 ${delta >= 0 ? '+' : ''}${number(delta)} 次${state.provider === 'modelscope' ? '（计数变化）' : ''}`}`;
}

$('sources').addEventListener('click', event => {
  const button = event.target.closest('button[data-source]');
  if (!button || button.dataset.source === state.provider) return;
  state.provider = button.dataset.source;
  state.group = 'all'; state.metric = 'all'; state.query = ''; state.sort = source().primary;
  $('search').value = '';
  const url = new URL(location.href);
  url.searchParams.set('source', state.provider);
  window.history.replaceState(null, '', url);
  showSource();
});
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
  if (!button || button.disabled || !state.snapshot) return;
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
