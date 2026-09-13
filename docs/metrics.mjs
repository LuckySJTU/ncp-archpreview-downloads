export const METRICS = { all: 'downloadsAllTime', month: 'downloads30d' };

export function selectModels(models, { group = 'all', query = '', sort = 'downloadsAllTime' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  const result = models.filter(m => (group === 'all' || m.group === group) && `${m.id} ${m.label}`.toLocaleLowerCase().includes(search));
  return result.sort((a, b) => sort === 'name'
    ? a.id.localeCompare(b.id, 'en', { numeric: true })
    : b[sort] - a[sort] || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export function sum(models, metric) {
  return models.reduce((total, m) => total + m[metric], 0);
}

export function comparison(current, baseline) {
  if (!baseline || current.collection.membershipHash !== baseline.collection.membershipHash) return null;
  return current.totals.downloadsAllTime - baseline.totals.downloadsAllTime;
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
