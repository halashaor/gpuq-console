import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {SqliteTaskAuthority} from '../src/infrastructure/sqlite/task-authority.mjs';
import {ValidateTrainingResources} from '../src/application/validate-training-resources.mjs';
import {GpuqPolicy} from '../src/infrastructure/gpuq-policy.mjs';
import {ReserveTaskExpansion} from '../src/application/reserve-task-expansion.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await computeFixture(t); f.ready(); createTrainingQueueSchema(f.database); createTrainingDispatchSchema(f.database);
  const queue = new SqliteTrainingQueue({database: f.database}), dispatches = new SqliteTrainingDispatches({database: f.database});
  function addJob(gpuCount = 2, accepted = true) {
    const input = trainingSubmission();
    input.resources = {...input.resources, maxGpus: 8, autoScaleUp: true, batch: {globalBatchSize: 64, microBatchSize: 4}};
    input.scheduling = {...input.scheduling, checkpoint: 'epoch-v1', restart: 'on-preempt', yieldPolicy: 'save'};
    const jobId = queue.enqueue(f.actor, input, f.now).request.jobId;
    dispatches.prepareForTask(jobId, {machineId: 'node-1', gpuCount}, f.now);
    if (accepted) {
      const permit = dispatches.beginSend(jobId, f.now);
      dispatches.recordSendOutcome({dispatchId: permit.dispatch.dispatchId, senderToken: permit.senderToken, nodeJobId: 'J' + randomUUID().replaceAll('-', '')});
    }
    return jobId;
  }
  const app = new ReserveTaskExpansion({authority: new SqliteTaskAuthority({database: f.database}), claims: f.claims,
    validator: new ValidateTrainingResources({policy: new GpuqPolicy({python: process.env.V2_PYTHON || 'python3'})})});
  return {...f, app, addJob, dispatches};
}

test('expansion reserves only the extra quota and never rewrites the immutable initial dispatch count', async t => {
  const f = await fixture(t), jobId = f.addJob(), original = f.dispatches.getForTask(jobId);
  const change = {changeId: randomUUID(), fromGpuCount: 2, targetGpuCount: 4};
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  const result = await f.app.execute(jobId, change);
  assert.equal(result.state, 'RESERVED');
  assert.deepEqual(await f.app.execute(jobId, change), result);
  assert.equal(f.claims.balancesForTask(jobId, ['node-1'])[0].heldTotal, 4);
  assert.deepEqual(f.dispatches.getForTask(jobId), original);
  const row = f.database.prepare('SELECT gpu_count,reserved_gpu_count FROM v2_compute_claims WHERE job_id=?').get(jobId);
  assert.equal(row.gpu_count, 2); assert.equal(row.reserved_gpu_count, 4);
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromGpuCount: 4, targetGpuCount: 8}), hasCode('COMPUTE_EXPANSION_PENDING'));
});

test('native legal-count rules reject fractional batch accumulation before any quota write', async t => {
  const f = await fixture(t), jobId = f.addJob();
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromGpuCount: 2, targetGpuCount: 3}), hasCode('INVALID_COMPUTE_EXPANSION'));
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_expansions').get().n, 0);
});

test('quota exhaustion, stale base count and unaccepted dispatch prevent expansion grants', async t => {
  const f = await fixture(t), jobId = f.addJob();
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromGpuCount: 1, targetGpuCount: 4}), hasCode('COMPUTE_CLAIM_CHANGED'));
  f.addJob();
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromGpuCount: 2, targetGpuCount: 4}), hasCode('COMPUTE_QUOTA_EXCEEDED'));
  const g = await fixture(t), pending = g.addJob(2, false);
  await assert.rejects(g.app.execute(pending, {changeId: randomUUID(), fromGpuCount: 2, targetGpuCount: 4}), hasCode('TRAINING_DISPATCH_NOT_ACCEPTED'));
});

test('failed quota update rolls back the expansion journal and original held count', async t => {
  const f = await fixture(t), jobId = f.addJob();
  f.database.exec("CREATE TRIGGER fail_expand BEFORE UPDATE ON v2_compute_claims BEGIN SELECT RAISE(ABORT,'expansion failure'); END");
  await assert.rejects(f.app.execute(jobId, {changeId: randomUUID(), fromGpuCount: 2, targetGpuCount: 4}), /expansion failure/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_expansions').get().n, 0);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});

test('an expansion identifier cannot be reused for another job and new grants obey current permissions', async t => {
  const f = await fixture(t), jobs = [f.addJob(1), f.addJob(1)];
  const change = {changeId: randomUUID(), fromGpuCount: 1, targetGpuCount: 2};
  await f.app.execute(jobs[0], change);
  await assert.rejects(f.app.execute(jobs[1], change), hasCode('COMPUTE_EXPANSION_CONFLICT'));
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  await assert.rejects(f.app.execute(jobs[1], {...change, changeId: randomUUID()}), hasCode('FORBIDDEN'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_expansions').get().n, 1);
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  await assert.rejects(f.app.execute(jobs[1], {...change, changeId: randomUUID()}), hasCode('TASK_NOT_AUTHORIZED'));
});

test('independent expansion writers cannot both reserve the last shared account credit', async t => {
  const f = await fixture(t), jobs = [f.addJob(1), f.addJob(1)];
  f.database.exec('UPDATE v2_compute_policies SET total_cards=3');
  const path = f.database.prepare('PRAGMA database_list').get().file;
  const moduleUrl = new URL('../src/infrastructure/sqlite/compute-claims.mjs', import.meta.url).href;
  const code = `
    import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const {SqliteComputeClaims} = await import(process.argv[1]);
    const value = JSON.parse(readFileSync(0,'utf8')), db = new DatabaseSync(value.path);
    db.exec('PRAGMA busy_timeout=5000');
    try { console.log(JSON.stringify(new SqliteComputeClaims({database:db}).reserveExpansionForTask(value.jobId,value.change,value.now))); }
    catch (error) { console.log(JSON.stringify({error:error.code})); }
    finally { db.close(); }
  `;
  const run = promisify(execFile);
  const results = await Promise.all(jobs.map(async jobId => {
    const child = run(process.execPath, ['--input-type=module', '-e', code, moduleUrl]);
    child.child.stdin.end(JSON.stringify({path, jobId, now: f.now, change: {changeId: randomUUID(), fromGpuCount: 1, targetGpuCount: 2}}));
    return JSON.parse((await child).stdout);
  }));
  assert.equal(results.filter(row => row.state === 'RESERVED').length, 1);
  assert.equal(results.filter(row => row.error === 'COMPUTE_QUOTA_EXCEEDED').length, 1);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 3);
});
