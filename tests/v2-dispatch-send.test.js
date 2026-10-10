import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dispatchFixture as fixture} from './helpers/v2-dispatch-fixture.mjs';
import {SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';

const hasCode = code => error => error.code === code;

test('one persisted send permit is granted and ordinary receipts do not reveal its token', async t => {
  const f = await fixture(t), permit = f.dispatches.beginSend(f.jobId, f.now);
  assert.equal(permit.acquired, true); assert.equal(permit.dispatch.state, 'SENDING');
  assert.equal(permit.dispatch.sendStartedAtMs, f.now);
  assert.equal(permit.dispatch.dispatchId, f.prepared.dispatchId);
  assert.equal(Object.hasOwn(permit.dispatch, 'senderToken'), false);
  const retry = f.dispatches.beginSend(f.jobId, f.now + 100);
  assert.deepEqual(retry, {acquired: false, dispatch: permit.dispatch});
  const db = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file);
  try {assert.equal(new SqliteTrainingDispatches({database: db}).beginSend(f.jobId, f.now + 1000).acquired, false);}
  finally {db.close();}
  assert.equal(f.queue.get(f.actor, f.jobId, f.now).state, 'SENDING');
});

test('unknown delivery retains quota and cannot resend; a late matching acceptance resolves it', async t => {
  const f = await fixture(t), permit = f.dispatches.beginSend(f.jobId, f.now);
  const identity = {dispatchId: permit.dispatch.dispatchId, senderToken: permit.senderToken};
  assert.equal(f.dispatches.recordSendOutcome({...identity, nodeJobId: null}).state, 'UNKNOWN');
  assert.equal(f.dispatches.beginSend(f.jobId, f.now + 10000).acquired, false);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
  const accepted = f.dispatches.recordSendOutcome({...identity, nodeJobId: 'J0123456789ab'});
  assert.equal(accepted.state, 'ACCEPTED');
  assert.deepEqual(f.dispatches.recordSendOutcome({...identity, nodeJobId: null}), accepted);
  assert.deepEqual(f.dispatches.recordSendOutcome({...identity, nodeJobId: accepted.nodeJobId}), accepted);
  assert.throws(() => f.dispatches.recordSendOutcome({...identity, nodeJobId: 'Jother'}), hasCode('DISPATCH_OUTCOME_CONFLICT'));
  assert.equal(f.queue.get(f.actor, f.jobId, f.now).state, 'ACCEPTED');
});

test('unowned or malformed send outcomes cannot bind an unrelated node job', async t => {
  const f = await fixture(t);
  assert.throws(() => f.dispatches.recordSendOutcome({dispatchId: f.prepared.dispatchId, senderToken: null, nodeJobId: 'Jabc'}), hasCode('DISPATCH_SEND_CONFLICT'));
  const permit = f.dispatches.beginSend(f.jobId, f.now);
  assert.throws(() => f.dispatches.recordSendOutcome({dispatchId: f.prepared.dispatchId, senderToken: 'wrong', nodeJobId: 'Jabc'}), hasCode('DISPATCH_SEND_CONFLICT'));
  assert.throws(() => f.dispatches.recordSendOutcome({dispatchId: f.prepared.dispatchId, senderToken: permit.senderToken, nodeJobId: '../path'}), hasCode('INVALID_DISPATCH_OUTCOME'));
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'SENDING');
});

test('new send rechecks current grants and limits, but late evidence can be recorded after account disable', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE v2_compute_policies SET total_cards=1');
  assert.throws(() => f.dispatches.beginSend(f.jobId, f.now), hasCode('COMPUTE_QUOTA_EXCEEDED'));
  f.database.exec("UPDATE v2_compute_policies SET total_cards=4; DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  assert.throws(() => f.dispatches.beginSend(f.jobId, f.now), hasCode('FORBIDDEN'));
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'PREPARED');
  f.database.exec("INSERT INTO v2_machine_grants VALUES('alice','node-1',4)");
  const permit = f.dispatches.beginSend(f.jobId, f.now);
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
  const accepted = f.dispatches.recordSendOutcome({dispatchId: permit.dispatch.dispatchId, senderToken: permit.senderToken, nodeJobId: 'Jabc'});
  assert.equal(accepted.state, 'ACCEPTED');
  assert.throws(() => f.dispatches.beginSend(f.jobId, f.now), hasCode('TASK_NOT_AUTHORIZED'));
});

test('failed send-permit persistence never returns permission to send', async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER fail_send BEFORE UPDATE ON v2_training_dispatches BEGIN SELECT RAISE(ABORT,'send persistence failure'); END");
  assert.throws(() => f.dispatches.beginSend(f.jobId, f.now), /send persistence failure/);
  assert.equal(f.dispatches.getForTask(f.jobId).state, 'PREPARED');
  f.database.exec('DROP TRIGGER fail_send');
  assert.equal(f.dispatches.beginSend(f.jobId, f.now).acquired, true);
});

test('independent sender processes obtain exactly one send permit', async t => {
  const f = await fixture(t), path = f.database.prepare('PRAGMA database_list').get().file;
  const moduleUrl = new URL('../src/infrastructure/sqlite/training-dispatches.mjs', import.meta.url).href;
  const code = `
    import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const {SqliteTrainingDispatches} = await import(process.argv[1]);
    const value = JSON.parse(readFileSync(0,'utf8')), db = new DatabaseSync(value.path);
    db.exec('PRAGMA busy_timeout=5000');
    try { console.log(JSON.stringify(new SqliteTrainingDispatches({database:db}).beginSend(value.jobId,value.now))); }
    finally { db.close(); }
  `;
  const run = promisify(execFile);
  const results = await Promise.all([1, 2].map(async () => {
    const child = run(process.execPath, ['--input-type=module', '-e', code, moduleUrl]);
    child.child.stdin.end(JSON.stringify({path, jobId: f.jobId, now: f.now}));
    return JSON.parse((await child).stdout);
  }));
  assert.equal(results.filter(row => row.acquired).length, 1);
  assert.deepEqual(results[0].dispatch, results[1].dispatch);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});
