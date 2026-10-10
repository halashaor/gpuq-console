import test from 'node:test';
import assert from 'node:assert/strict';
import {GpuqPolicy} from '../src/infrastructure/gpuq-policy.mjs';

const policy = new GpuqPolicy({python: process.env.V2_PYTHON || 'python3'});
const batch = {target_global_batch_size: 64, per_device_micro_batch_size: 4, min_gpu_count: 1, max_gpu_count: 8,
  free_gpu_count: 7, current_gpu_count: null};
const victim = (id, values = {}) => ({attempt_id: id, job_id: 'job-' + id, priority: 0, gpu_count: 1,
  checkpoint_capability: 'none', yield_policy: 'now', restart_policy: 'never', ...values});
const request = values => ({requester_priority: 4, requester_gpu_count: 1, free_gpu_count: 0,
  dispatch_mode: 'queue', preempt_opt_in_only: true, candidates: [], ...values});
const invalid = error => error.code === 'INVALID_SCHEDULING_REQUEST';

test('elastic launch uses the largest exactly divisible card count and keeps global batch/LR unchanged', async () => {
  const result = await policy.elastic(batch);
  assert.deepEqual(result.allowedGpuCounts, [1, 2, 4, 8]);
  assert.equal(result.launchGpuCount, 4);
  assert.deepEqual(result.batchPlans.map(row => row.accumulationSteps), [16, 8, 4, 2]);
  assert.ok(result.batchPlans.every(row => row.effectiveGlobalBatch === 64 && row.lrScale === 1));
  assert.equal((await policy.elastic({...batch, free_gpu_count: 8})).launchGpuCount, 8);
});

test('newly free cards produce a legal scale-up target instead of locking the initial world size', async () => {
  assert.equal((await policy.elastic({...batch, current_gpu_count: 2, free_gpu_count: 5})).scaleTarget, 4);
  assert.equal((await policy.elastic({...batch, current_gpu_count: 2, free_gpu_count: 6})).scaleTarget, 8);
  assert.equal((await policy.elastic({...batch, current_gpu_count: 4, free_gpu_count: 0})).scaleTarget, null);
  await assert.rejects(policy.elastic({...batch, current_gpu_count: 3}), invalid);
});

test('no legal batch count or insufficient free cards is not rounded into a launch', async () => {
  assert.equal((await policy.elastic({...batch, min_gpu_count: 4, free_gpu_count: 3})).launchGpuCount, null);
  assert.deepEqual((await policy.elastic({...batch, target_global_batch_size: 7, min_gpu_count: 2})).allowedGpuCounts, []);
  await assert.rejects(policy.elastic({...batch, max_gpu_count: 1000000000}), invalid);
  await assert.rejects(policy.elastic({...batch, target_global_batch_size: Number.MAX_SAFE_INTEGER + 1}), invalid);
});

test('planning supports larger pools without an eight-card assumption', async () => {
  const larger = {...batch, target_global_batch_size: 256, per_device_micro_batch_size: 2, max_gpu_count: 64};
  const plan = await policy.elastic({...larger, free_gpu_count: 48});
  assert.deepEqual(plan.allowedGpuCounts, [1, 2, 4, 8, 16, 32, 64]);
  assert.equal(plan.launchGpuCount, 32);
  assert.equal((await policy.elastic({...larger, current_gpu_count: 32, free_gpu_count: 32})).scaleTarget, 64);
});

test('ambient training environment cannot alter a pure batch preview', async () => {
  const names = ['WORLD_SIZE', 'GPUQ_TARGET_GLOBAL_BATCH_SIZE'];
  const old = names.map(name => process.env[name]);
  try {
    process.env.WORLD_SIZE = '99'; process.env.GPUQ_TARGET_GLOBAL_BATCH_SIZE = '999';
    assert.equal((await policy.elastic(batch)).launchGpuCount, 4);
  } finally {
    names.forEach((name, index) => {if (old[index] === undefined) delete process.env[name]; else process.env[name] = old[index];});
  }
});

test('priority P1 passes pending P0 and equal priority retains submission sequence', async () => {
  assert.deepEqual(await policy.queue({jobs: [{id: 'low', priority: 0, sequence: 0}, {id: 'later', priority: 1, sequence: 3},
    {id: 'first', priority: 1, sequence: 2}, {id: 'urgent', priority: 4, sequence: 4}]}), {jobIds: ['urgent', 'first', 'later', 'low']});
});

test('queue-mode automatic preemption affects only explicitly yielding lower-priority attempts', async () => {
  const result = await policy.preemption(request({candidates: [victim('protected', {yield_policy: 'never'}),
    victim('legacy', {yield_policy: 'legacy'}), victim('equal', {priority: 4}), victim('willing')]}));
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.victims, [{jobId: 'job-willing', attemptId: 'willing', mode: 'preempt-now', gpuCount: 1}]);
});

test('one pinned-card request yields the entire distributed attempt and honors its save contract', async () => {
  const result = await policy.preemption(request({dispatch_mode: 'preempt-now', required_gpu_uuids: ['GPU-a'], free_gpu_uuids: [],
    candidates: [victim('ddp', {gpu_count: 4, gpu_uuids: ['GPU-a', 'GPU-b', 'GPU-c', 'GPU-d'],
      checkpoint_capability: 'epoch-v1', yield_policy: 'save'})]}));
  assert.deepEqual(result.victims, [{jobId: 'job-ddp', attemptId: 'ddp', mode: 'preempt-save', gpuCount: 4}]);
  assert.equal(result.satisfied, true);
});

test('preemption only satisfies an elastic minimum and never interrupts more jobs to reach the maximum', async () => {
  const result = await policy.preemption(request({requester_gpu_count: 8, requester_min_gpu_count: 2, free_gpu_count: 1,
    candidates: [victim('one'), victim('many', {gpu_count: 4})]}));
  assert.deepEqual(result.victims.map(row => row.attemptId), ['one']);
  assert.equal(result.satisfied, true);
  assert.equal((await policy.preemption(request({candidates: [victim('unsavable', {yield_policy: 'save'})]}))).satisfied, false);
});

test('duplicate attempts and invalid priorities fail without a partial plan', async () => {
  await assert.rejects(policy.preemption(request({candidates: [victim('same'), victim('same')]})), invalid);
  await assert.rejects(policy.queue({jobs: [{id: 'bad', priority: 5, sequence: 0}]}), invalid);
});
