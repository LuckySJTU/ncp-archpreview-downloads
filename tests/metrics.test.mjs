import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModels, comparison, historySegments, sum } from '../docs/metrics.mjs';

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
