import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {createTrainingCatalogSchema, SqliteTrainingCatalog} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {SqliteTaskAuthority} from '../src/infrastructure/sqlite/task-authority.mjs';
import {ObserveTaskCandidates} from '../src/application/observe-task-candidates.mjs';
import {ObserveTrainingResources} from '../src/application/observe-training-resources.mjs';
import {ValidateTrainingResources} from '../src/application/validate-training-resources.mjs';
import {GpuqPolicy} from '../src/infrastructure/gpuq-policy.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {PrepareTaskDispatch} from '../src/application/prepare-task-dispatch.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await computeFixture(t); f.ready();
  createTrainingDispatchSchema(f.database);
  createTrainingQueueSchema(f.database); createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  const submission = trainingSubmission(); submission.machines = {kind: 'selected', ids: ['node-1']};
  f.database.exec("INSERT INTO v2_projects(id,owner_id) VALUES('project-1','alice')");
  f.database.prepare('INSERT INTO v2_project_releases VALUES(?,?)').run('project-1', submission.project.release);
  f.database.prepare('INSERT INTO v2_release_locations VALUES(?,?,?)').run('project-1', submission.project.release, 'node-1');
  f.database.prepare('INSERT INTO v2_project_instances VALUES(?,?,?,?,?)').run('project-1', 'node-1', 'training', randomUUID(), 'b'.repeat(64));
  const jobId = new SqliteTrainingQueue({database: f.database}).enqueue(f.actor, submission, f.now).request.jobId;
  return {...f, jobId, submission, catalog: new SqliteTrainingCatalog({database: f.database})};
}

test('task catalogue and balance reuse foreground rules after logout without extending sessions', async t => {
  const f = await fixture(t);
  const expected = f.catalog.snapshot(f.actor, f.submission, f.now);
  const balances = f.claims.balances(f.actor, ['node-1'], f.now);
  f.database.exec('UPDATE v2_sessions SET revoked=1,expires_at_ms=0');
  const writes = f.database.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(f.catalog.snapshotForTask(f.jobId), expected);
  assert.deepEqual(f.claims.balancesForTask(f.jobId, ['node-1']), balances);
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, writes);
  assert.throws(() => f.catalog.snapshot(f.actor, f.submission, f.now), hasCode('UNAUTHENTICATED'));
});

test('task observation respects current project archive, ownership and exact release registration', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE v2_projects SET archived=1');
  assert.throws(() => f.catalog.snapshotForTask(f.jobId), hasCode('PROJECT_ARCHIVED'));
  f.database.exec("UPDATE v2_projects SET archived=0; INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob'); UPDATE v2_projects SET owner_id='bob'");
  assert.throws(() => f.catalog.snapshotForTask(f.jobId), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_projects SET owner_id='alice'; DELETE FROM v2_release_locations");
  const result = f.catalog.snapshotForTask(f.jobId);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.excluded[0].reason, 'release-not-registered');
});

test('task machine scope cannot expand and revoked grants or disabled accounts stop observations', async t => {
  const f = await fixture(t);
  assert.throws(() => f.claims.balancesForTask(f.jobId, ['node-2']), hasCode('TASK_SCOPE_MISMATCH'));
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  assert.equal(f.catalog.snapshotForTask(f.jobId).excluded[0].reason, 'not-authorized');
  assert.throws(() => f.claims.balancesForTask(f.jobId, ['node-1']), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  assert.throws(() => f.catalog.snapshotForTask(f.jobId), hasCode('TASK_NOT_AUTHORIZED'));
  assert.throws(() => f.claims.balancesForTask(f.jobId, ['node-1']), hasCode('TASK_NOT_AUTHORIZED'));
});

test('task balances include held quota and refuse uninitialized accounting just like session balances', async t => {
  const f = await fixture(t);
  f.claims.claim(f.actor, {jobId: f.job(), machineId: 'node-1', gpuCount: 3}, f.now);
  assert.equal(f.claims.balancesForTask(f.jobId, ['node-1'])[0].remainingGpus, 1);
  f.database.exec('UPDATE v2_compute_accounting SET ready=0');
  assert.throws(() => f.claims.balancesForTask(f.jobId, ['node-1']), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
});

test('worker candidate pipeline runs after logout and rechecks account authority after node I/O', async t => {
  const f = await fixture(t), instance = f.catalog.snapshotForTask(f.jobId).instances[0];
  const identity = {accountId: 'alice', machineId: 'node-1', project: 'training', release: f.submission.project.release,
    projectUUID: instance.projectUUID, generation: instance.generation, environmentMode: 'oci', lifecycle: 'ACTIVE'};
  const projects = {
    async inspect() {return {...identity, runtimeVerified: false};},
    async verifyRuntime() {return {...identity, runtimeIdentityVerified: true, runtime: {kind: 'oci', identity: 'sha256:' + 'a'.repeat(64)}};},
  };
  const pools = {async inspect() {return {machineId: 'node-1', gpuUuids: ['GPU-a', 'GPU-b'], freeGpuUuids: ['GPU-a', 'GPU-b'], dispatchEnabled: true};}};
  const app = new ObserveTaskCandidates({authority: new SqliteTaskAuthority({database: f.database}), catalog: f.catalog,
    projects, sources: {async inspect() {assert.fail('No datasets requested');}}, quota: f.claims,
    resources: new ObserveTrainingResources({pools, validator: new ValidateTrainingResources({policy: new GpuqPolicy({python: process.env.V2_PYTHON || 'python3'})})})});
  f.database.exec('UPDATE v2_sessions SET revoked=1,expires_at_ms=0');
  const result = await app.execute(f.jobId);
  assert.equal(result.candidates[0].quotaFit.exclusiveFreeFitGpuCount, 2);
  assert.equal(f.claims.balancesForTask(f.jobId, ['node-1'])[0].heldTotal, 0);
  const prepare = new PrepareTaskDispatch({observer: app, dispatches: new SqliteTrainingDispatches({database: f.database})});
  const prepared = await prepare.execute(f.jobId);
  assert.equal(prepared.kind, 'prepared'); assert.equal(prepared.dispatch.gpuCount, 2);
  assert.equal(f.claims.balancesForTask(f.jobId, ['node-1'])[0].heldTotal, 2);
  assert.deepEqual(await prepare.execute(f.jobId), prepared);
  projects.inspect = async () => {
    f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
    return {...identity, runtimeVerified: false};
  };
  await assert.rejects(app.execute(f.jobId), hasCode('TASK_NOT_AUTHORIZED'));
});
