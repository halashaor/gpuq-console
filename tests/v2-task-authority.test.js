import test from 'node:test';
import assert from 'node:assert/strict';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingDispatchSchema} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {SqliteTaskAuthority} from '../src/infrastructure/sqlite/task-authority.mjs';
import {ResolveTaskData} from '../src/application/resolve-task-data.mjs';
import {LocalSourceReader} from '../src/infrastructure/local-source-reader.mjs';
import {SqliteSourceCatalog} from '../src/infrastructure/sqlite/data-read-repositories.mjs';

const source = {kind: 'directory', sourceId: 'images'}, request = {machineId: 'node-1', source};
const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await computeFixture(t); createTrainingDispatchSchema(f.database); createTrainingQueueSchema(f.database);
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('someone-else','other','Other')");
  const queue = new SqliteTrainingQueue({database: f.database}), input = trainingSubmission();
  input.machines = {kind: 'selected', ids: ['node-1']}; input.dataSources = [source];
  const jobId = queue.enqueue(f.actor, input, f.now).request.jobId;
  return {...f, input, jobId, authority: new SqliteTaskAuthority({database: f.database})};
}

test('queued task identity and original data scope survive logout and session expiry without fabricated sessions', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE v2_sessions SET revoked=1,expires_at_ms=0; UPDATE v2_accounts SET auth_revision=auth_revision+1');
  const context = f.authority.context(f.jobId);
  assert.equal(context.accountId, 'alice'); assert.deepEqual(context.submission, f.input);
  assert.equal(Object.hasOwn(context, 'sessionId'), false);
  const changes = f.database.prepare('SELECT total_changes() n').get().n;
  f.authority.requireDataRead(f.jobId, request);
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, changes);
});

test('unsubmitted records and disabled accounts cannot become task principals', async t => {
  const f = await fixture(t);
  assert.throws(() => f.authority.context(f.job()), hasCode('TASK_NOT_AUTHORIZED'));
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  assert.throws(() => f.authority.context(f.jobId), hasCode('TASK_NOT_AUTHORIZED'));
  assert.throws(() => f.authority.requireDataRead(f.jobId, request), hasCode('TASK_NOT_AUTHORIZED'));
});

test('task data reads cannot expand the submitted source or selected machine scope', async t => {
  const f = await fixture(t);
  assert.throws(() => f.authority.requireDataRead(f.jobId, {...request, machineId: 'node-2'}), hasCode('TASK_SCOPE_MISMATCH'));
  assert.throws(() => f.authority.requireDataRead(f.jobId, {...request, source: {kind: 'directory', sourceId: 'other'}}), hasCode('TASK_SCOPE_MISMATCH'));
  assert.throws(() => f.authority.requireDataRead(f.jobId, {...request, accountId: 'admin'}), hasCode('INVALID_REQUEST'));
});

test('current machine and data grants are checked even after a previous task read succeeded', async t => {
  const f = await fixture(t);
  f.authority.requireDataRead(f.jobId, request);
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  assert.throws(() => f.authority.requireDataRead(f.jobId, request), hasCode('FORBIDDEN'));
  f.database.exec("INSERT INTO v2_machine_grants VALUES('alice','node-1',4); UPDATE v2_data_resources SET visibility='private',owner_id='someone-else' WHERE id='images'");
  assert.throws(() => f.authority.requireDataRead(f.jobId, request), hasCode('FORBIDDEN'));
  f.database.exec("INSERT INTO v2_data_readers VALUES('images','alice')");
  f.authority.requireDataRead(f.jobId, request);
  f.database.exec("DELETE FROM v2_data_readers WHERE account_id='alice'");
  assert.throws(() => f.authority.requireDataRead(f.jobId, request), hasCode('FORBIDDEN'));
});

test('current administrator machine access never grants another owner’s private dataset', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_accounts SET role='admin' WHERE id='alice'; DELETE FROM v2_machine_grants");
  f.authority.requireDataRead(f.jobId, request);
  f.database.exec("UPDATE v2_data_resources SET visibility='private',owner_id='someone-else' WHERE id='images'");
  assert.throws(() => f.authority.requireDataRead(f.jobId, request), hasCode('FORBIDDEN'));
});

test('real task directory observation reuses direct reads after logout and denies later revocation', async t => {
  const f = await fixture(t);
  const app = new ResolveTaskData({authority: f.authority,
    sources: new LocalSourceReader({machineId: 'node-1', catalog: new SqliteSourceCatalog({database: f.database})})});
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  assert.deepEqual(await app.execute(f.jobId, 'node-1'), [{...request, availability: 'available',
    location: {containerPath: '/datasets/images', readOnly: true}}]);
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  await assert.rejects(app.execute(f.jobId, 'node-1'), hasCode('FORBIDDEN'));
});

test('cancellation during data observation invalidates the in-flight task result', async t => {
  const f = await fixture(t);
  const app = new ResolveTaskData({authority: f.authority, sources: {async inspect() {
    new SqliteTrainingQueue({database: f.database}).cancel(f.actor, f.jobId, f.now);
    return {availability: 'available'};
  }}});
  await assert.rejects(app.execute(f.jobId, 'node-1'), hasCode('TASK_NOT_AUTHORIZED'));
});
