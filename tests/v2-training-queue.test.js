import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';
import {SqliteTaskAuthority} from '../src/infrastructure/sqlite/task-authority.mjs';
import {loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await computeFixture(t); createTrainingDispatchSchema(f.database); createTrainingQueueSchema(f.database);
  return {...f, queue: new SqliteTrainingQueue({database: f.database}), dispatches: new SqliteTrainingDispatches({database: f.database})};
}

test('queue order survives reopen: descending priority then FIFO, with stable pagination', async t => {
  const f = await fixture(t), receipts = [];
  for (const priority of [0, 4, 2, 4]) {
    const input = trainingSubmission(); input.scheduling.priority = priority;
    receipts.push(f.queue.enqueue(f.actor, input, f.now));
  }
  const expected = [receipts[1], receipts[3], receipts[2], receipts[0]].map(row => row.request.jobId);
  const page1 = f.queue.pending({limit: 2}), page2 = f.queue.pending({limit: 2, after: page1.at(-1)});
  assert.deepEqual([...page1, ...page2].map(row => row.jobId), expected);
  const db = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file, {readOnly: true});
  try {assert.deepEqual(new SqliteTrainingQueue({database: db}).pending().map(row => row.jobId), expected);}
  finally {db.close();}
  assert.ok(page1.every(row => !Object.hasOwn(row, 'execution')));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_claims').get().n, 0);
});

test('enqueue is idempotent, changed content conflicts, and insertion failure rolls back the input', async t => {
  const f = await fixture(t), input = trainingSubmission(), first = f.queue.enqueue(f.actor, input, f.now);
  assert.deepEqual(f.queue.enqueue(f.actor, input, f.now + 100), first);
  assert.throws(() => f.queue.enqueue(f.actor, {...input, scheduling: {...input.scheduling, priority: 4}}, f.now), hasCode('TRAINING_REQUEST_CONFLICT'));
  f.database.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON v2_training_queue BEGIN SELECT RAISE(ABORT,'injected queue failure'); END");
  assert.throws(() => f.queue.enqueue(f.actor, trainingSubmission(), f.now), /injected queue failure/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_requests').get().n, 1);
  assert.equal(f.queue.pending().length, 1);
});

test('prepared jobs disappear from pending without a second mutable queue state', async t => {
  const f = await fixture(t); f.ready();
  const input = trainingSubmission(), queued = f.queue.enqueue(f.actor, input, f.now), jobId = queued.request.jobId;
  assert.equal(f.queue.get(f.actor, jobId, f.now).state, 'QUEUED');
  const prepared = f.dispatches.prepare(f.actor, {jobId, machineId: 'node-1', gpuCount: 2}, f.now);
  assert.deepEqual(f.queue.pending(), []);
  assert.equal(f.queue.get(f.actor, jobId, f.now).dispatchId, prepared.dispatchId);
  assert.equal(f.queue.get(f.actor, jobId, f.now).state, 'PREPARED');
  assert.deepEqual(f.queue.enqueue(f.actor, input, f.now + 100), queued);
  assert.deepEqual(f.queue.pending(), []);
});

test('revoked sessions cannot enqueue or read; internal queue records persist and invalid pages fail', async t => {
  const f = await fixture(t), queued = f.queue.enqueue(f.actor, trainingSubmission(), f.now);
  f.database.exec("UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id='alice'");
  assert.throws(() => f.queue.enqueue(f.actor, trainingSubmission(), f.now), hasCode('UNAUTHENTICATED'));
  assert.throws(() => f.queue.get(f.actor, queued.request.jobId, f.now), hasCode('UNAUTHENTICATED'));
  assert.equal(f.queue.pending().length, 1); // Discovery is not execution authorization.
  for (const value of [{limit: 0}, {limit: 1001}, {after: {priority: 5, sequence: 1}}, {after: {priority: 1, sequence: 0}}]) {
    assert.throws(() => f.queue.pending(value), /Invalid queue page/);
  }
});

test('independent enqueue writers persist one request and one queue sequence', async t => {
  const f = await fixture(t), input = trainingSubmission();
  const path = f.database.prepare('PRAGMA database_list').get().file;
  const moduleUrl = new URL('../src/infrastructure/sqlite/training-queue.mjs', import.meta.url).href;
  const code = `
    import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const {SqliteTrainingQueue} = await import(process.argv[1]);
    const value = JSON.parse(readFileSync(0,'utf8')), db = new DatabaseSync(value.path);
    db.exec('PRAGMA busy_timeout=5000');
    try { console.log(JSON.stringify(new SqliteTrainingQueue({database:db}).enqueue(value.actor,value.input,value.now))); }
    finally { db.close(); }
  `;
  const run = promisify(execFile);
  const results = await Promise.all([1, 2].map(async () => {
    const child = run(process.execPath, ['--input-type=module', '-e', code, moduleUrl]);
    child.child.stdin.end(JSON.stringify({path, actor: f.actor, input, now: f.now}));
    return JSON.parse((await child).stdout);
  }));
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.queue.pending().length, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_requests').get().n, 1);
});

test('canceling a queued task is durable, releases unsent quota and cannot be undone by retry', async t => {
  const f = await fixture(t); f.ready();
  const input = trainingSubmission(), queued = f.queue.enqueue(f.actor, input, f.now), jobId = queued.request.jobId;
  f.claims.claim(f.actor, {jobId, machineId: 'node-1', gpuCount: 2}, f.now);
  const canceled = f.queue.cancel(f.actor, jobId, f.now);
  assert.equal(canceled.state, 'CANCELED');
  assert.deepEqual(f.queue.cancel(f.actor, jobId, f.now + 10), canceled);
  assert.equal(f.queue.get(f.actor, jobId, f.now).state, 'CANCELED');
  assert.deepEqual(f.queue.pending(), []);
  assert.equal(f.claims.get(f.actor, jobId, f.now).state, 'RELEASED');
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 0);
  assert.deepEqual(f.queue.enqueue(f.actor, input, f.now + 10), queued);
  assert.deepEqual(f.queue.pending(), []);
  assert.throws(() => new SqliteTaskAuthority({database: f.database}).context(jobId), hasCode('TASK_NOT_AUTHORIZED'));
  assert.throws(() => f.dispatches.prepare(f.actor, {jobId, machineId: 'node-1', gpuCount: 2}, f.now), hasCode('TRAINING_CANCELED'));
});

test('already prepared dispatches cannot be canceled as queue-only work or have quota released', async t => {
  const f = await fixture(t); f.ready();
  const jobId = f.queue.enqueue(f.actor, trainingSubmission(), f.now).request.jobId;
  f.dispatches.prepare(f.actor, {jobId, machineId: 'node-1', gpuCount: 2}, f.now);
  assert.throws(() => f.queue.cancel(f.actor, jobId, f.now), hasCode('TRAINING_DISPATCH_ALREADY_PREPARED'));
  assert.equal(f.claims.get(f.actor, jobId, f.now).state, 'HELD');
  assert.equal(f.queue.get(f.actor, jobId, f.now).state, 'PREPARED');
});

test('cancellation and quota release roll back together on storage failure', async t => {
  const f = await fixture(t); f.ready();
  const jobId = f.queue.enqueue(f.actor, trainingSubmission(), f.now).request.jobId;
  f.claims.claim(f.actor, {jobId, machineId: 'node-1', gpuCount: 2}, f.now);
  f.database.exec("CREATE TRIGGER fail_release BEFORE UPDATE ON v2_compute_claims BEGIN SELECT RAISE(ABORT,'injected release failure'); END");
  assert.throws(() => f.queue.cancel(f.actor, jobId, f.now), /injected release failure/);
  assert.equal(f.queue.get(f.actor, jobId, f.now).state, 'QUEUED');
  assert.equal(f.claims.get(f.actor, jobId, f.now).state, 'HELD');
  assert.equal(f.queue.pending().length, 1);
});

test('unsubmitted records and revoked callers cannot use queue cancellation', async t => {
  const f = await fixture(t);
  assert.throws(() => f.queue.cancel(f.actor, f.job(), f.now), hasCode('TRAINING_NOT_QUEUED'));
  const jobId = f.queue.enqueue(f.actor, trainingSubmission(), f.now).request.jobId;
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  assert.throws(() => f.queue.cancel(f.actor, jobId, f.now), hasCode('UNAUTHENTICATED'));
  assert.equal(f.queue.pending().length, 1);
});

test('another logged-in account cannot cancel someone else’s queue entry', async t => {
  const f = await fixture(t), jobId = f.queue.enqueue(f.actor, trainingSubmission(), f.now).request.jobId;
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login({...loginRequest, username: 'bob'});
  const bob = {id: 'bob', sessionId: f.database.prepare("SELECT id FROM v2_sessions WHERE account_id='bob'").get().id};
  assert.throws(() => f.queue.cancel(bob, jobId, f.now), hasCode('FORBIDDEN'));
  assert.equal(f.queue.get(f.actor, jobId, f.now).state, 'QUEUED');
});

test('independent cancellation and preparation writers have exactly one winning outcome', async t => {
  const f = await fixture(t); f.ready();
  const jobId = f.queue.enqueue(f.actor, trainingSubmission(), f.now).request.jobId;
  const path = f.database.prepare('PRAGMA database_list').get().file;
  const queueUrl = new URL('../src/infrastructure/sqlite/training-queue.mjs', import.meta.url).href;
  const dispatchUrl = new URL('../src/infrastructure/sqlite/training-dispatches.mjs', import.meta.url).href;
  const code = `
    import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const value = JSON.parse(readFileSync(0,'utf8')), db = new DatabaseSync(value.path);
    db.exec('PRAGMA busy_timeout=5000');
    try {
      const {SqliteTrainingQueue} = await import(value.queueUrl);
      const {SqliteTrainingDispatches} = await import(value.dispatchUrl);
      const result = value.action === 'cancel'
        ? new SqliteTrainingQueue({database:db}).cancel(value.actor,value.jobId,value.now)
        : new SqliteTrainingDispatches({database:db}).prepare(value.actor,{jobId:value.jobId,machineId:'node-1',gpuCount:2},value.now);
      console.log(JSON.stringify(result));
    } catch (error) { console.log(JSON.stringify({error:error.code})); }
    finally { db.close(); }
  `;
  const run = promisify(execFile);
  const results = await Promise.all(['cancel', 'prepare'].map(async action => {
    const child = run(process.execPath, ['--input-type=module', '-e', code]);
    child.child.stdin.end(JSON.stringify({path, queueUrl, dispatchUrl, actor: f.actor, jobId, action, now: f.now}));
    return JSON.parse((await child).stdout);
  }));
  const state = f.queue.get(f.actor, jobId, f.now).state;
  assert.ok(['CANCELED', 'PREPARED'].includes(state));
  assert.equal(results.filter(row => row.state === state).length, 1);
  assert.equal(results.filter(row => row.error === (state === 'CANCELED' ? 'TRAINING_CANCELED' : 'TRAINING_DISPATCH_ALREADY_PREPARED')).length, 1);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, state === 'CANCELED' ? 0 : 2);
});
