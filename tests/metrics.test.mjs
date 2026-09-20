import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModels, comparison, historySegments, sum, validate, combinedDownloads } from '../docs/metrics.mjs';

const models = [
  { id: 'org/Step2', group: 'Stage 1', label: 'Step 2', downloadsAllTime: 10, downloads30d: 3, likes: 0 },
  { id: 'org/Step10', group: 'Stage 1', label: 'Step 10', downloadsAllTime: 5, downloads30d: 4, likes: 1 },
  { id: 'org/Stage2', group: 'Stage 2', label: 'Stage 2', downloadsAllTime: 20, downloads30d: 1, likes: 2 },
];

test('filter, search and sort compose without mutating source', () => {
  assert.deepEqual(selectModels(models, { group: 'Stage 1', query: 'step', sort: 'downloads30d' }).map(m => m.id), ['org/Step10', 'org/Step2']);
  assert.equal(selectModels(models, { query: 'no match' }).length, 0);
  assert.deepEqual(selectModels(models, { sort: 'name' }).map(m => m.id), ['org/Stage2', 'org/Step2', 'org/Step10']);
  assert.equal(models[0].id, 'org/Step2');
  assert.equal(sum(selectModels(models, { group: 'Stage 1' }), 'downloadsAllTime'), 15);
});

test('changes in membership do not produce fabricated download growth', () => {
  const old = { collection: { membershipHash: 'old' }, totals: { downloadsAllTime: 10 } };
  const current = { collection: { membershipHash: 'new' }, totals: { downloadsAllTime: 25 } };
  assert.equal(comparison(current, old), null);
  current.collection.membershipHash = 'old';
  assert.equal(comparison(current, old), 15);
  current.totals.downloadsAllTime = 9;
  assert.equal(comparison(current, old), -1); // Keep Hub corrections visible.
  assert.equal(comparison(current, null), null);
});

test('history breaks at collection membership changes', () => {
  const points = ['a', 'a', 'b', 'a'].map(membershipHash => ({ membershipHash }));
  assert.deepEqual(historySegments(points).map(segment => segment.length), [2, 1, 1]);
});

test('ModelScope validates its own metric without inventing HF download windows', () => {
  const snapshot = {
    schemaVersion: 1, complete: true, provider: 'modelscope', generatedAt: '2026-09-20T12:00:00Z',
    collection: { modelCount: 1, membershipHash: 'ms' },
    totals: { platformDownloads: 14, likes: 1 },
    models: [{ id: 'org/Stage2_v1', label: 'Stage 2', group: 'Stage 2', platformDownloads: 14, likes: 1 }],
    groups: [{ name: 'Stage 2', modelCount: 1, platformDownloads: 14, likes: 1 }],
  };
  assert.doesNotThrow(() => validate(snapshot, 'modelscope'));
  assert.throws(() => validate(snapshot, 'huggingface'));
  const missing = structuredClone(snapshot);
  delete missing.models[0].platformDownloads;
  assert.throws(() => validate(missing, 'modelscope'));
  const incorrect = structuredClone(snapshot);
  incorrect.totals.platformDownloads = 0;
  assert.throws(() => validate(incorrect, 'modelscope'));
  assert.equal(comparison(snapshot, snapshot, 'platformDownloads'), 0);
  assert.equal(comparison(snapshot, snapshot), null);
  const baseline = structuredClone(snapshot);
  baseline.totals.platformDownloads = 10;
  assert.equal(comparison(snapshot, baseline, 'platformDownloads'), 4);
  baseline.provider = 'huggingface';
  assert.equal(comparison(snapshot, baseline, 'platformDownloads'), null);
});

test('ModelScope ranking uses platform counts', () => {
  const rows = [
    { id: 'org/A', label: 'A', group: 'Stage 1', platformDownloads: 8 },
    { id: 'org/B', label: 'B', group: 'Stage 2', platformDownloads: 18 },
  ];
  assert.deepEqual(selectModels(rows, { sort: 'platformDownloads' }).map(m => m.id), ['org/B', 'org/A']);
  assert.equal(sum(rows, 'platformDownloads'), 26);
});

test('pending models sort after readable models and keep counts missing', () => {
  const rows = [
    {id: 'org/A', label: 'A', group: 'Stage 1', status: 'pending'},
    {id: 'org/B', label: 'B', group: 'Stage 2', platformDownloads: 0},
  ];
  assert.deepEqual(selectModels(rows, {sort: 'platformDownloads'}).map(m => m.id), ['org/B', 'org/A']);
  const snapshot = {
    schemaVersion: 1, complete: true, provider: 'modelscope', generatedAt: '2026-09-20T12:00:00Z',
    collection: {modelCount: 1, targetCount: 2, pendingCount: 1}, totals: {platformDownloads: 0, likes: 0},
    models: [{...rows[1], likes: 0}], pendingModels: [rows[0]],
    groups: [{name: 'Stage 2', modelCount: 1, platformDownloads: 0, likes: 0}],
  };
  assert.doesNotThrow(() => validate(snapshot, 'modelscope'));
  snapshot.pendingModels[0].platformDownloads = 0;
  assert.throws(() => validate(snapshot, 'modelscope'));
});

test('combined total sums the explicit platform metrics and requires both sources', () => {
  const sources = {
    huggingface: {totals: {downloadsAllTime: 11904, downloads30d: 11864}},
    modelscope: {totals: {platformDownloads: 46}},
  };
  assert.equal(combinedDownloads(sources), 11950);
  assert.equal(combinedDownloads({huggingface: sources.huggingface}), null);
  assert.equal(combinedDownloads({...sources, modelscope: {totals: {platformDownloads: 0}}}), 11904);
  assert.equal(combinedDownloads({...sources, modelscope: {totals: {platformDownloads: null}}}), null);
});
