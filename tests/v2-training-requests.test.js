import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SqliteTrainingRequests, createTrainingRequestSchema} from '../src/infrastructure/sqlite/training-requests.mjs';
import {trainingSubmission} from './helpers/v2-training-submission.mjs';

const hasCode = code => error => error.code === code;
const request = () => {const value = trainingSubmission(); return {...value, name: '分类实验', description: 'ImageNet 基线\n保持有效 batch',
  execution: {...value.execution, env: {SECRET_FOR_TEST: 'private-test-value'}}};};
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  createTrainingRequestSchema(f.database);
  f.database.exec("UPDATE v2_accounts SET display_name='提交者甲' WHERE id='alice'");
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id};
  return {...f, actor, store: new SqliteTrainingRequests({database: f.database}), now: Date.now()};
}

test('records task labels and server-owned submitter identity without claiming GPUQ admission', async t => {
  const f = await fixture(t), input = request();
  const result = f.store.record(f.actor, input, f.now);
  assert.equal(result.state, 'RECORDED');
  assert.equal(result.name, input.name); assert.equal(result.description, input.description);
  assert.deepEqual(result.submitter, {accountId: 'alice', username: 'alice', displayName: '提交者甲'});
  assert.equal(JSON.stringify(result).includes('private-test-value'), false);
  f.database.exec("UPDATE v2_accounts SET display_name='后来改名' WHERE id='alice'");
  assert.deepEqual(f.store.get(f.actor, input.requestId, f.now), result);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_requests').get().n, 1);
});

test('reordered object fields recover one request; changed commands or task metadata conflict', async t => {
  const f = await fixture(t), input = request(), first = f.store.record(f.actor, input, f.now);
  const reordered = {...input, resources: Object.fromEntries(Object.entries(input.resources).reverse())};
  assert.deepEqual(f.store.record(f.actor, reordered, f.now + 10), first);
  for (const change of [{...input, name: '另一个实验'}, {...input, execution: {...input.execution, argv: ['train.py', 'python']}}]) {
    assert.throws(() => f.store.record(f.actor, change, f.now), hasCode('TRAINING_REQUEST_CONFLICT'));
  }
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_requests').get().n, 1);
});

test('read-only database reopen recovers the same durable receipt after response loss', async t => {
  const f = await fixture(t), input = request(), result = f.store.record(f.actor, input, f.now);
  const reopened = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file, {readOnly: true});
  try {assert.deepEqual(new SqliteTrainingRequests({database: reopened}).get(f.actor, input.requestId, f.now), result);}
  finally {reopened.close();}
  assert.equal(f.store.get(f.actor, randomUUID(), f.now), null);
});

test('another account cannot query or reuse a recorded request ID, and revoked sessions cannot write', async t => {
  const f = await fixture(t), input = request(); f.store.record(f.actor, input, f.now);
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login({...loginRequest, username: 'bob'});
  const bob = {id: 'bob', sessionId: f.database.prepare("SELECT id FROM v2_sessions WHERE account_id='bob'").get().id};
  assert.throws(() => f.store.get(bob, input.requestId, f.now), hasCode('FORBIDDEN'));
  const jobId = f.store.get(f.actor, input.requestId, f.now).jobId;
  assert.throws(() => f.store.submission(bob, jobId, f.now), hasCode('FORBIDDEN'));
  assert.throws(() => f.store.record(bob, input, f.now), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_accounts SET auth_revision=1 WHERE id='alice'");
  assert.throws(() => f.store.record(f.actor, request(), f.now), hasCode('UNAUTHENTICATED'));
});

test('dispatcher reads the same immutable structured submission without exposing it in receipts', async t => {
  const f = await fixture(t), input = request();
  input.name = '  分类实验  ';
  input.dataSources = [{kind: 'warehouse', datasetId: 'imagenet', version: 'b'.repeat(64)}];
  const stored = f.store.record(f.actor, input, f.now);
  const expected = {...structuredClone(input), name: '分类实验'};
  input.execution.argv.push('--changed'); input.dataSources.length = 0;
  assert.deepEqual(f.store.submission(f.actor, stored.jobId, f.now), expected);
  assert.equal(Object.hasOwn(stored, 'execution'), false);
  const db = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file, {readOnly: true});
  try {assert.deepEqual(new SqliteTrainingRequests({database: db}).submission(f.actor, stored.jobId, f.now), expected);}
  finally {db.close();}
});

test('old generic prepared payloads are never interpreted as executable training submissions', async t => {
  const f = await fixture(t), input = request(), stored = f.store.record(f.actor, input, f.now);
  const old = JSON.stringify({name: 'old', description: '', preparedSpec: {argv: ['legacy']}});
  f.database.prepare('UPDATE v2_training_requests SET payload_json=? WHERE job_id=?').run(old, stored.jobId);
  assert.throws(() => f.store.submission(f.actor, stored.jobId, f.now), hasCode('TRAINING_REQUEST_SCHEMA_MISMATCH'));
  assert.equal(f.store.get(f.actor, input.requestId, f.now).jobId, stored.jobId);
  assert.equal(f.database.prepare('SELECT payload_json FROM v2_training_requests WHERE job_id=?').get(stored.jobId).payload_json, old);
});

test('insertion failure leaves no phantom job or receipt', async t => {
  const f = await fixture(t), input = request();
  f.database.exec("CREATE TRIGGER fail_request BEFORE INSERT ON v2_training_requests BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(() => f.store.record(f.actor, input, f.now), /injected failure/);
  assert.equal(f.store.get(f.actor, input.requestId, f.now), null);
  f.database.exec('DROP TRIGGER fail_request');
  assert.equal(f.store.record(f.actor, input, f.now).state, 'RECORDED');
});

test('unsafe JSON identity, excessive payload and caller identity injection are rejected', async t => {
  const f = await fixture(t), input = request();
  const cyclic = {}; cyclic.self = cyclic;
  for (const env of [{x: undefined}, {x: Infinity}, {x: new Date()}, cyclic]) {
    assert.throws(() => f.store.record(f.actor, {...input, execution: {...input.execution, env}}, f.now), hasCode('INVALID_TRAINING_REQUEST'));
  }
  assert.throws(() => f.store.record(f.actor, {...input, submitter: {displayName: '伪造'}}, f.now), hasCode('INVALID_TRAINING_REQUEST'));
  assert.throws(() => f.store.record(f.actor, {...input, execution: {...input.execution, argv: ['x'.repeat(65536)]}}, f.now), hasCode('INVALID_TRAINING_REQUEST'));
  assert.throws(() => f.store.record(f.actor, {...input, preparedSpec: {}}, f.now), hasCode('INVALID_TRAINING_REQUEST'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_requests').get().n, 0);
});

test('independent writer processes resolve the same request to one durable job identity', async t => {
  const f = await fixture(t), input = request();
  const path = f.database.prepare('PRAGMA database_list').get().file;
  const moduleUrl = new URL('../src/infrastructure/sqlite/training-requests.mjs', import.meta.url).href;
  const run = promisify(execFile);
  const code = `
    import {DatabaseSync} from 'node:sqlite';
    import {readFileSync} from 'node:fs';
    const {SqliteTrainingRequests} = await import(process.argv[1]);
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const db = new DatabaseSync(input.path);
    db.exec('PRAGMA busy_timeout=5000');
    try { console.log(JSON.stringify(new SqliteTrainingRequests({database:db}).record(input.actor,input.request,input.now))); }
    finally { db.close(); }
  `;
  const write = async () => {
    const running = run(process.execPath, ['--input-type=module', '-e', code, moduleUrl]);
    running.child.stdin.end(JSON.stringify({path, actor: f.actor, request: input, now: f.now}));
    return JSON.parse((await running).stdout);
  };
  const results = await Promise.all([write(), write()]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(f.store.get(f.actor, input.requestId, f.now), results[0]);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_requests').get().n, 1);
});
