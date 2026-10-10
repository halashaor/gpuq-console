import test from 'node:test';
import assert from 'node:assert/strict';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {PrepareTaskDispatch} from '../src/application/prepare-task-dispatch.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await computeFixture(t); f.ready(); createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  const queue = new SqliteTrainingQueue({database: f.database}), input = trainingSubmission();
  input.machines = {kind: 'selected', ids: ['node-1']};
  const jobId = queue.enqueue(f.actor, input, f.now).request.jobId;
  return {...f, jobId, queue, dispatches: new SqliteTrainingDispatches({database: f.database})};
}

test('task preparation after logout atomically holds quota and preserves the dispatch ID', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE v2_sessions SET revoked=1,expires_at_ms=0');
  const selection = {machineId: 'node-1', gpuCount: 2};
  const first = f.dispatches.prepareForTask(f.jobId, selection, f.now);
  assert.equal(first.state, 'PREPARED');
  assert.deepEqual(f.dispatches.prepareForTask(f.jobId, selection, f.now + 10), first);
  assert.deepEqual(f.dispatches.getForTask(f.jobId), first);
  assert.equal(f.claims.balancesForTask(f.jobId, ['node-1'])[0].heldTotal, 2);
});

test('task preparation cannot expand original machine or GPU count scope', async t => {
  const f = await fixture(t);
  for (const selection of [{machineId: 'node-2', gpuCount: 2}, {machineId: 'node-1', gpuCount: 5},
    {machineId: 'node-1', gpuCount: 0}, {machineId: 'node-1', gpuCount: 1.5}]) {
    assert.throws(() => f.dispatches.prepareForTask(f.jobId, selection, f.now), hasCode('TASK_SCOPE_MISMATCH'));
  }
  assert.equal(f.dispatches.getForTask(f.jobId), null);
  assert.equal(f.claims.balancesForTask(f.jobId, ['node-1'])[0].heldTotal, 0);
});

test('task write rechecks machine grant, accounting readiness and account state after prior observation', async t => {
  const f = await fixture(t), selection = {machineId: 'node-1', gpuCount: 2};
  f.dispatches.getForTask(f.jobId);
  f.database.exec('UPDATE v2_compute_accounting SET ready=0');
  assert.throws(() => f.dispatches.prepareForTask(f.jobId, selection, f.now), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
  f.ready(); f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  assert.throws(() => f.dispatches.prepareForTask(f.jobId, selection, f.now), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  assert.throws(() => f.dispatches.prepareForTask(f.jobId, selection, f.now), hasCode('TASK_NOT_AUTHORIZED'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_dispatches').get().n, 0);
});

test('cancellation between task observation and preparation prevents quota and dispatch writes', async t => {
  const f = await fixture(t);
  const app = new PrepareTaskDispatch({dispatches: f.dispatches, observer: {async execute(jobId) {
    f.queue.cancel(f.actor, jobId, f.now);
    return {candidates: [{machineId: 'node-1', quotaFit: {exclusiveFreeFitGpuCount: 2}}]};
  }}});
  await assert.rejects(app.execute(f.jobId), hasCode('TASK_NOT_AUTHORIZED'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_claims').get().n, 0);
  assert.equal(f.queue.get(f.actor, f.jobId, f.now).state, 'CANCELED');
});

test('task dispatch storage failure rolls back the quota hold exactly like session preparation', async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER fail_task_dispatch BEFORE INSERT ON v2_training_dispatches BEGIN SELECT RAISE(ABORT,'task dispatch failure'); END");
  assert.throws(() => f.dispatches.prepareForTask(f.jobId, {machineId: 'node-1', gpuCount: 2}, f.now), /task dispatch failure/);
  assert.equal(f.dispatches.getForTask(f.jobId), null);
  assert.equal(f.claims.balancesForTask(f.jobId, ['node-1'])[0].heldTotal, 0);
});
