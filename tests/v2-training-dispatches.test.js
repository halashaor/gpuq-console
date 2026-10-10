import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await computeFixture(t);
  createTrainingDispatchSchema(f.database);
  return {...f, dispatches: new SqliteTrainingDispatches({database: f.database}), command: {jobId: f.job(), machineId: 'node-1', gpuCount: 2}};
}

test('dispatch intent and quota hold are committed together and recover the original ID', async t => {
  const f = await fixture(t); f.ready();
  const first = f.dispatches.prepare(f.actor, f.command, f.now);
  assert.equal(first.state, 'PREPARED'); assert.match(first.dispatchId, /^[a-f0-9-]{36}$/);
  assert.equal(f.claims.get(f.actor, f.command.jobId, f.now).state, 'HELD');
  assert.deepEqual(f.dispatches.prepare(f.actor, f.command, f.now + 10), first);
  const db = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file, {readOnly: true});
  try {assert.deepEqual(new SqliteTrainingDispatches({database: db}).get(f.actor, f.command.jobId, f.now), first);}
  finally {db.close();}
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
  assert.throws(() => f.dispatches.prepare(f.actor, {...f.command, machineId: 'node-2'}, f.now), hasCode('TRAINING_DISPATCH_CONFLICT'));
});

test('failure after quota insertion rolls back both records and retry prepares one intent', async t => {
  const f = await fixture(t); f.ready();
  f.database.exec("CREATE TRIGGER fail_dispatch BEFORE INSERT ON v2_training_dispatches BEGIN SELECT RAISE(ABORT,'injected dispatch failure'); END");
  assert.throws(() => f.dispatches.prepare(f.actor, f.command, f.now), /injected dispatch failure/);
  assert.equal(f.claims.get(f.actor, f.command.jobId, f.now), null);
  assert.equal(f.dispatches.get(f.actor, f.command.jobId, f.now), null);
  f.database.exec('DROP TRIGGER fail_dispatch');
  assert.equal(f.dispatches.prepare(f.actor, f.command, f.now).state, 'PREPARED');
});

test('unready accounting and exhausted quota never leave a dispatch intent', async t => {
  const f = await fixture(t);
  assert.throws(() => f.dispatches.prepare(f.actor, f.command, f.now), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
  f.ready();
  f.claims.claim(f.actor, {jobId: f.job(), machineId: 'node-2', gpuCount: 4}, f.now);
  assert.throws(() => f.dispatches.prepare(f.actor, f.command, f.now), hasCode('COMPUTE_QUOTA_EXCEEDED'));
  assert.equal(f.dispatches.get(f.actor, f.command.jobId, f.now), null);
});

test('an old hold is not new dispatch authority after machine access is removed or accounting is closed', async t => {
  const f = await fixture(t); f.ready();
  f.claims.claim(f.actor, f.command, f.now);
  f.database.exec('UPDATE v2_compute_accounting SET ready=0');
  assert.throws(() => f.dispatches.prepare(f.actor, f.command, f.now), hasCode('COMPUTE_ACCOUNTING_UNREADY'));
  f.ready(); f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-1'");
  assert.throws(() => f.dispatches.prepare(f.actor, f.command, f.now), hasCode('FORBIDDEN'));
  assert.equal(f.dispatches.get(f.actor, f.command.jobId, f.now), null);
});

test('released quota cannot create a new dispatch and revoked sessions cannot recover intents', async t => {
  const f = await fixture(t); f.ready();
  f.claims.claim(f.actor, f.command, f.now);
  f.database.exec("UPDATE v2_compute_claims SET state='RELEASED'");
  assert.throws(() => f.dispatches.prepare(f.actor, f.command, f.now), hasCode('COMPUTE_CLAIM_NOT_HELD'));
  f.database.exec("UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id='alice'");
  assert.throws(() => f.dispatches.get(f.actor, f.command.jobId, f.now), hasCode('UNAUTHENTICATED'));
});

test('independent writers cannot prepare the same job on two different machines', async t => {
  const f = await fixture(t); f.ready();
  const path = f.database.prepare('PRAGMA database_list').get().file;
  const moduleUrl = new URL('../src/infrastructure/sqlite/training-dispatches.mjs', import.meta.url).href;
  const code = `
    import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const {SqliteTrainingDispatches} = await import(process.argv[1]);
    const value = JSON.parse(readFileSync(0,'utf8')), db = new DatabaseSync(value.path);
    db.exec('PRAGMA busy_timeout=5000');
    try { console.log(JSON.stringify(new SqliteTrainingDispatches({database:db}).prepare(value.actor,value.command,value.now))); }
    catch (error) { console.log(JSON.stringify({error:error.code})); }
    finally { db.close(); }
  `;
  const run = promisify(execFile);
  const results = await Promise.all(['node-1', 'node-2'].map(async machineId => {
    const child = run(process.execPath, ['--input-type=module', '-e', code, moduleUrl]);
    child.child.stdin.end(JSON.stringify({path, actor: f.actor, command: {...f.command, machineId}, now: f.now}));
    return JSON.parse((await child).stdout);
  }));
  assert.equal(results.filter(value => value.state === 'PREPARED').length, 1);
  assert.equal(results.filter(value => value.error === 'TRAINING_DISPATCH_CONFLICT').length, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_training_dispatches').get().n, 1);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});
