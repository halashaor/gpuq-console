import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dispatchFixture} from './helpers/v2-dispatch-fixture.mjs';
import {SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {ReconcileTrainingDispatch} from '../src/application/reconcile-training-dispatch.mjs';

const hasCode = code => error => error.code === code;
function acceptance(f) {
  const value = f.dispatches.delivery(f.prepared.dispatchId);
  return {dispatchId: value.dispatchId, jobId: value.jobId, machineId: value.machineId,
    gpuCount: value.gpuCount, accountId: value.accountId, requestHash: value.requestHash, nodeJobId: 'J0123456789ab'};
}

test('a reopened coordinator confirms the original node acceptance without the lost sender token', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const observed = acceptance(f), db = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file);
  try {
    const store = new SqliteTrainingDispatches({database: db}); let calls = 0;
    const app = new ReconcileTrainingDispatch({dispatches: store, nodes: {async lookup(input) {
      calls++; assert.deepEqual(input, {machineId: 'node-1', dispatchId: f.prepared.dispatchId}); return observed;
    }}});
    f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
    const result = await app.execute(f.prepared.dispatchId);
    assert.equal(result.kind, 'accepted'); assert.equal(result.dispatch.nodeJobId, observed.nodeJobId);
    assert.equal(Object.hasOwn(result.dispatch, 'senderToken'), false);
    assert.equal(Object.hasOwn(result.dispatch, 'execution'), false);
    assert.deepEqual(await app.execute(f.prepared.dispatchId), result); assert.equal(calls, 1);
    assert.equal(f.database.prepare("SELECT gpu_count FROM v2_compute_claims WHERE job_id=? AND state='HELD'").get(f.jobId).gpu_count, 2);
  } finally {db.close();}
});

test('not observed and failed lookups neither resend nor release quota', async t => {
  const f = await dispatchFixture(t), permit = f.dispatches.beginSend(f.jobId, f.now);
  f.dispatches.recordSendOutcome({dispatchId: permit.dispatch.dispatchId, senderToken: permit.senderToken, nodeJobId: null});
  const nodes = {async lookup() {return null;}}, app = new ReconcileTrainingDispatch({dispatches: f.dispatches, nodes});
  assert.equal((await app.execute(f.prepared.dispatchId)).kind, 'unconfirmed');
  nodes.lookup = async () => {throw new Error('offline');};
  await assert.rejects(app.execute(f.prepared.dispatchId), /offline/);
  assert.equal(f.dispatches.delivery(f.prepared.dispatchId).state, 'UNKNOWN');
  assert.equal(f.dispatches.beginSend(f.jobId, f.now + 100000).acquired, false);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});

test('node evidence must match task, account, machine, count, dispatch and immutable request digest', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const observed = acceptance(f);
  for (const change of [{jobId: 'other'}, {accountId: 'other'}, {machineId: 'other'}, {gpuCount: 3},
    {dispatchId: 'other'}, {requestHash: '0'.repeat(64)}]) {
    const app = new ReconcileTrainingDispatch({dispatches: f.dispatches, nodes: {async lookup() {return {...observed, ...change};}}});
    await assert.rejects(app.execute(f.prepared.dispatchId), hasCode('DISPATCH_OBSERVATION_MISMATCH'));
    assert.equal(f.dispatches.delivery(f.prepared.dispatchId).state, 'SENDING');
  }
});

test('unsent dispatches are never confirmed and unknown IDs make no node request', async t => {
  const f = await dispatchFixture(t); let calls = 0;
  const app = new ReconcileTrainingDispatch({dispatches: f.dispatches, nodes: {async lookup() {calls++;}}});
  assert.equal((await app.execute(f.prepared.dispatchId)).kind, 'not-sent');
  assert.throws(() => f.dispatches.confirmAcceptance(acceptance(f)), hasCode('DISPATCH_NOT_SENT'));
  await assert.rejects(app.execute('missing'), hasCode('TRAINING_DISPATCH_NOT_FOUND'));
  assert.equal(calls, 0);
});

test('confirmed node identity is immutable and a conflicting recovery reply is rejected', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const observed = acceptance(f), first = f.dispatches.confirmAcceptance(observed);
  assert.deepEqual(f.dispatches.confirmAcceptance(observed), first);
  assert.throws(() => f.dispatches.confirmAcceptance({...observed, nodeJobId: 'Jother'}), hasCode('DISPATCH_OUTCOME_CONFLICT'));
  assert.equal(f.dispatches.delivery(f.prepared.dispatchId).nodeJobId, observed.nodeJobId);
});

test('an empty query cannot overwrite a concurrent confirmed acceptance in the returned view', async t => {
  const f = await dispatchFixture(t); f.dispatches.beginSend(f.jobId, f.now);
  const observed = acceptance(f);
  const app = new ReconcileTrainingDispatch({dispatches: f.dispatches, nodes: {async lookup() {
    f.dispatches.confirmAcceptance(observed); return null;
  }}});
  const result = await app.execute(f.prepared.dispatchId);
  assert.equal(result.kind, 'accepted'); assert.equal(result.dispatch.nodeJobId, observed.nodeJobId);
});
