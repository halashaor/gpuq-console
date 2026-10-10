import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {createTrainingQueueSchema, SqliteTrainingQueue} from '../src/infrastructure/sqlite/training-queue.mjs';

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
