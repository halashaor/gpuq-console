import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingQuotaFit} from '../src/domain/training-quota-fit.mjs';

const fit = {allowedGpuCounts: [2, 4, 8], exclusiveFreeFitGpuCount: 8, waitingFor: null};

test('quota intersection chooses only legal counts without changing the resource observation', () => {
  const result = trainingQuotaFit(fit, {machineId: 'node', remainingGpus: 5});
  assert.deepEqual(result.allowedGpuCounts, [2, 4]);
  assert.equal(result.exclusiveFreeFitGpuCount, 4);
  assert.deepEqual(fit.allowedGpuCounts, [2, 4, 8]);
  assert.equal(fit.exclusiveFreeFitGpuCount, 8);
});

test('exhausted or insufficient quota preserves waiting instead of inventing a smaller batch', () => {
  for (const remainingGpus of [0, 1]) {
    const result = trainingQuotaFit(fit, {machineId: 'node', remainingGpus});
    assert.deepEqual(result.allowedGpuCounts, []);
    assert.equal(result.exclusiveFreeFitGpuCount, null);
    assert.equal(result.waitingFor, 'quota');
  }
});

test('available quota does not undo resource, sharing or dispatch waits', () => {
  for (const waitingFor of ['free-capacity', 'sharing-admission', 'dispatch-disabled']) {
    const result = trainingQuotaFit({...fit, exclusiveFreeFitGpuCount: null, waitingFor}, {machineId: 'node', remainingGpus: 8});
    assert.equal(result.exclusiveFreeFitGpuCount, null);
    assert.equal(result.waitingFor, waitingFor);
  }
});
