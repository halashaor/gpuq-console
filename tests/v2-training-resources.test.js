import test from 'node:test';
import assert from 'node:assert/strict';
import {ValidateTrainingResources} from '../src/application/validate-training-resources.mjs';
import {GpuqPolicy} from '../src/infrastructure/gpuq-policy.mjs';

const admission = new ValidateTrainingResources({policy: new GpuqPolicy({python: process.env.V2_PYTHON || 'python3'})});
const pool = {gpuUuids: Array.from({length: 8}, (_, index) => 'GPU-' + index)};
const invalid = error => error.code === 'INVALID_SCHEDULING_REQUEST';
function submission() {
  return {execution: {env: {PRIVATE_TEST_VALUE: 'not-in-result'}},
    resources: {minGpus: 3, maxGpus: 8, elastic: true, autoScaleUp: true, placement: 'any', gpuUuids: [], batch: {globalBatchSize: 64, microBatchSize: 4}, sharing: null},
    scheduling: {priority: 3, mode: 'queue', yieldPolicy: 'save', checkpoint: 'epoch-v1', restart: 'on-preempt'}};
}

test('V2 intent is validated by native GPUQ resource rules without needing cwd or executable paths', async () => {
  const input = submission(), result = await admission.execute(input, pool);
  assert.deepEqual(result.allowedGpuCounts, [4, 8]);
  assert.equal(result.resources.priority, 3);
  assert.equal(result.resources.auto_scale_up, true);
  assert.equal(result.resources.preempt_opt_in_only, true);
  assert.equal(JSON.stringify(result).includes('not-in-result'), false);
  assert.equal(input.resources.minGpus, 3);
});

test('native checkpoint/restart/batch requirements govern automatic expansion', async () => {
  for (const mutate of [
    value => value.scheduling.checkpoint = 'none',
    value => value.scheduling.restart = 'never',
    value => value.resources.batch = null,
    value => value.resources.minGpus = 8,
    value => value.resources.elastic = false,
  ]) {
    const input = submission(); mutate(input);
    await assert.rejects(admission.execute(input, pool), invalid);
  }
});

test('fixed placement must match the exact managed UUID pool', async () => {
  const input = submission();
  input.resources = {...input.resources, minGpus: 1, maxGpus: 1, elastic: false, autoScaleUp: false, batch: null, placement: 'pinned', gpuUuids: ['GPU-7']};
  assert.deepEqual((await admission.execute(input, pool)).allowedGpuCounts, [1]);
  input.resources.gpuUuids = ['GPU-outside'];
  await assert.rejects(admission.execute(input, pool), invalid);
  input.resources.gpuUuids = [];
  await assert.rejects(admission.execute(input, pool), invalid);
});

test('shared GPU and HAMi constraints come from the same validator as ordinary GPUQ submission', async () => {
  const input = submission();
  input.resources = {minGpus: 1, maxGpus: 1, elastic: false, autoScaleUp: false, placement: 'pinned', gpuUuids: ['GPU-1'], batch: null,
    sharing: {vramMiB: 2048, hami: {smPercent: 30}}};
  input.scheduling = {priority: 1, mode: 'queue', yieldPolicy: 'never', checkpoint: 'none', restart: 'never'};
  const result = await admission.execute(input, pool);
  assert.equal(result.resources.hami_core, true); assert.equal(result.resources.sm_percent, 30);
  input.execution.env.LD_PRELOAD = '/user/library.so';
  await assert.rejects(admission.execute(input, pool), invalid);
  delete input.execution.env.LD_PRELOAD;
  input.scheduling.mode = 'preempt-now';
  await assert.rejects(admission.execute(input, pool), invalid);
});

test('invalid inventory is not interpreted as capacity and empty inventory is explicit', async () => {
  await assert.rejects(admission.execute(submission(), {gpuUuids: ['GPU-1', 'GPU-1']}), error => error.code === 'GPU_INVENTORY_INVALID');
  await assert.rejects(admission.execute(submission(), {gpuUuids: []}), error => error.code === 'GPU_POOL_EMPTY');
  await assert.rejects(admission.execute(submission(), {gpuUuids: ['GPU-1']}), invalid);
});
