import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {createTrainingRequestSchema, SqliteTrainingRequests} from '../src/infrastructure/sqlite/training-requests.mjs';
import {createComputeClaimsSchema, SqliteComputeClaims} from '../src/infrastructure/sqlite/compute-claims.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  createTrainingRequestSchema(f.database); createComputeClaimsSchema(f.database);
  f.database.exec(`UPDATE v2_machines SET cards=8; UPDATE v2_machine_grants SET max_cards=4;
    INSERT INTO v2_machines(id,cards) VALUES('node-2',8);
    INSERT INTO v2_machine_grants VALUES('alice','node-2',4);
    INSERT INTO v2_compute_policies VALUES('alice',4,0)`);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id}, now = Date.now();
  const requests = new SqliteTrainingRequests({database: f.database}), claims = new SqliteComputeClaims({database: f.database});
  const job = () => requests.record(actor, {requestId: randomUUID(), name: '训练', description: '', preparedSpec: {}}, now).jobId;
  return {...f, actor, now, job, claims, ready() {f.database.exec('UPDATE v2_compute_accounting SET ready=1');}};
}

test('new accounting refuses unknown legacy usage rather than treating it as zero', async t => {
  const f = await fixture(t), jobId = f.job();
  assert.throws(() => f.claims.balance(f.actor, 'node-1', f.now), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
  assert.throws(() => f.claims.claim(f.actor, {jobId, machineId: 'node-1', gpuCount: 1}, f.now), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
  assert.equal(f.claims.get(f.actor, jobId, f.now), null);
});

test('machine and total quota include held dispatches, even after a limit is reduced', async t => {
  const f = await fixture(t); f.ready();
  f.claims.claim(f.actor, {jobId: f.job(), machineId: 'node-1', gpuCount: 3}, f.now);
  const second = {jobId: f.job(), machineId: 'node-2', gpuCount: 2};
  assert.throws(() => f.claims.claim(f.actor, second, f.now), hasCode('COMPUTE_QUOTA_EXCEEDED'));
  assert.equal(f.claims.balance(f.actor, 'node-2', f.now).remainingGpus, 1);
  f.database.exec('UPDATE v2_compute_policies SET total_cards=2');
  const balance = f.claims.balance(f.actor, 'node-1', f.now);
  assert.equal(balance.heldTotal, 3); assert.equal(balance.remainingGpus, 0);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_compute_claims').get().n, 1);
});

test('same job recovers its claim without double charging and released receipts cannot resurrect holds', async t => {
  const f = await fixture(t); f.ready();
  const request = {jobId: f.job(), machineId: 'node-1', gpuCount: 2};
  const first = f.claims.claim(f.actor, request, f.now);
  assert.deepEqual(f.claims.claim(f.actor, request, f.now + 100), first);
  assert.throws(() => f.claims.claim(f.actor, {...request, gpuCount: 1}, f.now), hasCode('COMPUTE_CLAIM_CONFLICT'));
  f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'; UPDATE v2_compute_accounting SET ready=0");
  assert.deepEqual(f.claims.claim(f.actor, request, f.now), first); // Receipt recovery only, not new authorization.
  f.database.exec("UPDATE v2_compute_claims SET state='RELEASED'"); // Simulate a future verified terminal transition.
  assert.equal(f.claims.claim(f.actor, request, f.now).state, 'RELEASED');
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_compute_claims WHERE state='HELD'").get().n, 0);
});

test('failed insertion rolls back and revoked sessions cannot reserve or recover claims', async t => {
  const f = await fixture(t); f.ready();
  const request = {jobId: f.job(), machineId: 'node-1', gpuCount: 2};
  f.database.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON v2_compute_claims BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(() => f.claims.claim(f.actor, request, f.now), /injected failure/);
  assert.equal(f.claims.get(f.actor, request.jobId, f.now), null);
  f.database.exec('DROP TRIGGER fail_claim');
  f.database.exec("UPDATE v2_accounts SET auth_revision=1 WHERE id='alice'");
  assert.throws(() => f.claims.claim(f.actor, request, f.now), hasCode('UNAUTHENTICATED'));
  assert.throws(() => f.claims.get(f.actor, request.jobId, f.now), hasCode('UNAUTHENTICATED'));
});

test('another account cannot reserve or query someone else’s job even with machine access', async t => {
  const f = await fixture(t); f.ready();
  const request = {jobId: f.job(), machineId: 'node-1', gpuCount: 1};
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice';
    INSERT INTO v2_machine_grants VALUES('bob','node-1',4);
    INSERT INTO v2_compute_policies VALUES('bob',4,0)`);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login({...loginRequest, username: 'bob'});
  const bob = {id: 'bob', sessionId: f.database.prepare("SELECT id FROM v2_sessions WHERE account_id='bob'").get().id};
  assert.throws(() => f.claims.claim(bob, request, f.now), hasCode('FORBIDDEN'));
  f.claims.claim(f.actor, request, f.now);
  assert.throws(() => f.claims.get(bob, request.jobId, f.now), hasCode('FORBIDDEN'));
  assert.throws(() => f.claims.claim(bob, request, f.now), hasCode('FORBIDDEN'));
});

test('independent writers cannot both consume the last quota across machines', async t => {
  const f = await fixture(t); f.ready();
  f.database.exec('UPDATE v2_compute_policies SET total_cards=2');
  const path = f.database.prepare('PRAGMA database_list').get().file;
  const moduleUrl = new URL('../src/infrastructure/sqlite/compute-claims.mjs', import.meta.url).href;
  const code = `
    import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const {SqliteComputeClaims} = await import(process.argv[1]);
    const value = JSON.parse(readFileSync(0,'utf8')), db = new DatabaseSync(value.path);
    db.exec('PRAGMA busy_timeout=5000');
    try { console.log(JSON.stringify(new SqliteComputeClaims({database:db}).claim(value.actor,value.request,value.now))); }
    catch (error) { console.log(JSON.stringify({error:error.code})); }
    finally { db.close(); }
  `;
  const run = promisify(execFile);
  const requests = ['node-1', 'node-2'].map(machineId => ({jobId: f.job(), machineId, gpuCount: 2}));
  const results = await Promise.all(requests.map(async request => {
    const child = run(process.execPath, ['--input-type=module', '-e', code, moduleUrl]);
    child.child.stdin.end(JSON.stringify({path, actor: f.actor, request, now: f.now}));
    return JSON.parse((await child).stdout);
  }));
  assert.equal(results.filter(value => value.state === 'HELD').length, 1);
  assert.equal(results.filter(value => value.error === 'COMPUTE_QUOTA_EXCEEDED').length, 1);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});
