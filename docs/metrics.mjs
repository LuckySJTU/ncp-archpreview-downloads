export const METRICS = { all: 'downloadsAllTime', month: 'downloads30d' };
export const SOURCES = {
  huggingface: { name: 'Hugging Face', directory: '', primary: 'downloadsAllTime', label: '累计下载', likes: '获赞', modelBase: 'https://huggingface.co/', fields: ['downloadsAllTime', 'downloads30d', 'likes'] },
  modelscope: { name: '魔搭 ModelScope', directory: 'modelscope/', primary: 'platformDownloads', label: '平台下载量', likes: '收藏', modelBase: 'https://www.modelscope.cn/models/', fields: ['platformDownloads', 'likes'] },
};

export function combinedDownloads(snapshots) {
  // Both sources are required: a missing platform must not silently become zero.
  let total = 0;
  for (const [provider, config] of Object.entries(SOURCES)) {
    const value = snapshots[provider]?.totals?.[config.primary];
    if (!Number.isSafeInteger(value) || value < 0) return null;
    total += value;
  }
  return Number.isSafeInteger(total) ? total : null;
}

export function validate(snapshot, provider = 'huggingface') {
  if (snapshot.schemaVersion !== 1 || (snapshot.provider ?? 'huggingface') !== provider || !snapshot.complete || !Array.isArray(snapshot.models) || !snapshot.models.length || !snapshot.collection || !snapshot.totals || !Array.isArray(snapshot.groups) || !Number.isFinite(Date.parse(snapshot.generatedAt))) throw new Error('快照格式不完整或平台不匹配');
  const seen = new Set();
  for (const model of snapshot.models) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model.id) || seen.has(model.id)) throw new Error('模型 ID 无效或重复');
    seen.add(model.id);
    for (const key of SOURCES[provider].fields) if (!Number.isSafeInteger(model[key]) || model[key] < 0) throw new Error('模型统计缺失');
  }
  for (const key of SOURCES[provider].fields) if (!Number.isSafeInteger(snapshot.totals[key]) || sum(snapshot.models, key) !== snapshot.totals[key]) throw new Error('快照汇总校验失败');
  if (seen.size !== snapshot.collection.modelCount) throw new Error('模型覆盖数量不一致');
  if (snapshot.pendingModels !== undefined) {
    if (!Array.isArray(snapshot.pendingModels)) throw new Error('待上线模型格式无效');
    for (const model of snapshot.pendingModels) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model.id) || seen.has(model.id) || model.status !== 'pending' || SOURCES[provider].fields.some(key => model[key] != null)) throw new Error('待上线模型不应含有下载计数');
      seen.add(model.id);
    }
    if (snapshot.collection.targetCount !== seen.size || snapshot.collection.pendingCount !== snapshot.pendingModels.length) throw new Error('预接入模型数量不一致');
  }
  const groups = new Set(snapshot.models.map(m => m.group));
  if (snapshot.groups.length !== groups.size || new Set(snapshot.groups.map(g => g.name)).size !== groups.size) throw new Error('模型分组不一致');
  for (const group of snapshot.groups) {
    const members = snapshot.models.filter(m => m.group === group.name);
    if (!groups.has(group.name) || members.length !== group.modelCount || SOURCES[provider].fields.some(key => group[key] !== sum(members, key))) throw new Error('模型分组合计不一致');
  }
}

export function selectModels(models, { group = 'all', query = '', sort = 'downloadsAllTime' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  const result = models.filter(m => (group === 'all' || m.group === group) && `${m.id} ${m.label}`.toLocaleLowerCase().includes(search));
  return result.sort((a, b) => {
    const byName = a.id.localeCompare(b.id, 'en', { numeric: true });
    if (sort === 'name') return byName;
    const aValid = Number.isSafeInteger(a[sort]), bValid = Number.isSafeInteger(b[sort]);
    if (aValid !== bValid) return aValid ? -1 : 1;
    return aValid ? b[sort] - a[sort] || byName : byName;
  });
}

export function sum(models, metric) {
  return models.reduce((total, m) => total + m[metric], 0);
}

export function comparison(current, baseline, metric = 'downloadsAllTime') {
  if (!baseline || (current.provider ?? 'huggingface') !== (baseline.provider ?? 'huggingface') || current.collection.membershipHash !== baseline.collection.membershipHash || !Number.isSafeInteger(current.totals[metric]) || !Number.isSafeInteger(baseline.totals[metric])) return null;
  return current.totals[metric] - baseline.totals[metric];
}

export function historySegments(points) {
  const segments = [];
  for (const point of points) {
    const last = segments.at(-1);
    if (!last || last.at(-1).membershipHash !== point.membershipHash) segments.push([point]);
    else last.push(point);
  }
  return segments;
}
