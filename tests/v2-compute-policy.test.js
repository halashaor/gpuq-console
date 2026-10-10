import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFixture, loginRequest, readRequest} from './helpers/v2-session-fixture.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {ComputePolicyClient} from '../src/client/compute-policy-client.mjs';
import {parseComputePolicy} from '../src/contracts/compute-policy.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  f.database.exec(`UPDATE v2_machines SET cards=8 WHERE id='node-1';
    INSERT INTO v2_machines(id,cards) VALUES('node-2',6);
    INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  async function client(username) {
    const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
    const session = new SessionClient({transport, delivery: 'token'});
    await session.login({...loginRequest, username});
    return {session, policies: new ComputePolicyClient({transport}), data: new DataClient({transport})};
  }
  return {...f, admin: await client('alice'), member: await client('bob')};
}
const policy = (revision = 0) => ({accountId: 'bob', revision, totalCards: 4,
  limits: [{machineId: 'node-1', maxCards: 3}, {machineId: 'node-2', maxCards: 2}]});

test('machine grants and card limits commit together; revoke applies to live sessions without touching data', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.admin.policies.get({accountId: 'bob'}), {accountId: 'bob', revision: 0, totalCards: 0, limits: []});
  await assert.rejects(f.member.data.resolveReadLocation(readRequest), hasCode('FORBIDDEN'));
  assert.deepEqual(await f.admin.policies.set(policy()), {...policy(), revision: 1});
  assert.equal((await f.member.data.resolveReadLocation(readRequest)).availability, 'available');
  await f.admin.policies.set({accountId: 'bob', revision: 1, totalCards: 0, limits: []});
  await assert.rejects(f.member.data.resolveReadLocation(readRequest), hasCode('FORBIDDEN'));
  await f.member.session.refresh();
  assert.equal(f.database.prepare("SELECT auth_revision FROM v2_accounts WHERE id='bob'").get().auth_revision, 0);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_resources').get().n, 1);
});

test('ordinary users cannot grant themselves machines and administrators do not receive member quotas', async t => {
  const f = await fixture(t);
  await assert.rejects(f.member.policies.set(policy()), hasCode('FORBIDDEN'));
  await assert.rejects(f.member.policies.get({accountId: 'alice'}), hasCode('FORBIDDEN'));
  await assert.rejects(f.admin.policies.set({...policy(), accountId: 'alice'}), hasCode('ADMIN_POLICY_INHERITED'));
});

test('capacity, total and unknown machines are validated without partial grant updates', async t => {
  const f = await fixture(t);
  for (const [command, code] of [
    [{...policy(), totalCards: 6}, 'INVALID_COMPUTE_POLICY'],
    [{...policy(), totalCards: 0}, 'INVALID_COMPUTE_POLICY'],
    [{...policy(), limits: []}, 'INVALID_COMPUTE_POLICY'],
    [{...policy(), limits: [{machineId: 'node-1', maxCards: 9}]}, 'POLICY_CAPACITY_EXCEEDED'],
    [{...policy(), limits: [{machineId: 'unknown', maxCards: 4}]}, 'MACHINE_NOT_FOUND'],
  ]) await assert.rejects(f.admin.policies.set(command), hasCode(code));
  f.database.exec("UPDATE v2_machines SET cards=NULL WHERE id='node-1'");
  await assert.rejects(f.admin.policies.set(policy()), hasCode('MACHINE_CAPACITY_UNKNOWN'));
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_machine_grants WHERE account_id='bob'").get().n, 0);
});

test('stale and concurrent edits cannot overwrite the newer policy', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.admin.policies.set(policy()), f.admin.policies.set({...policy(), totalCards: 2})]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'POLICY_CHANGED');
  const current = await f.admin.policies.get({accountId: 'bob'});
  assert.equal(current.revision, 1);
  await assert.rejects(f.admin.policies.set(policy()), hasCode('POLICY_CHANGED'));
});

test('failed replacement rolls back removed grants and quota revision together', async t => {
  const f = await fixture(t);
  const original = await f.admin.policies.set(policy());
  f.database.exec("CREATE TRIGGER fail_policy BEFORE UPDATE ON v2_compute_policies BEGIN SELECT RAISE(ABORT,'injected policy failure'); END");
  await assert.rejects(f.admin.policies.set({accountId: 'bob', revision: 1, totalCards: 0, limits: []}), hasCode('INTERNAL_ERROR'));
  assert.deepEqual(await f.admin.policies.get({accountId: 'bob'}), original);
  assert.equal((await f.member.data.resolveReadLocation(readRequest)).availability, 'available');
});

test('legacy grants with unknown limits are not presented as zero quota', async t => {
  const f = await fixture(t);
  f.database.exec("INSERT INTO v2_machine_grants(account_id,machine_id) VALUES('bob','node-1')");
  await assert.rejects(f.admin.policies.get({accountId: 'bob'}), hasCode('POLICY_UNINITIALIZED'));
});

test('duplicate machine entries and caller identity never enter a policy write', () => {
  const value = policy();
  for (const command of [{...value, limits: [value.limits[0], value.limits[0]]}, {...value, actor: 'alice'}, {...value, revision: -1}]) {
    assert.throws(() => parseComputePolicy(command), hasCode('INVALID_REQUEST'));
  }
});

test('machine grants do not bypass private data permission or disabled machine state', async t => {
  const f = await fixture(t);
  await f.admin.policies.set(policy());
  f.database.exec("UPDATE v2_data_resources SET visibility='private',owner_id='alice'");
  await assert.rejects(f.member.data.resolveReadLocation(readRequest), hasCode('FORBIDDEN'));
  f.database.exec("INSERT INTO v2_data_readers VALUES('images','bob')");
  assert.equal((await f.member.data.resolveReadLocation(readRequest)).availability, 'available');
  f.database.exec("UPDATE v2_machines SET enabled=0 WHERE id='node-1'");
  await assert.rejects(f.member.data.resolveReadLocation(readRequest), hasCode('FORBIDDEN'));
});

test('administrator revocation blocks policy reads and writes', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id='alice'");
  await assert.rejects(f.admin.policies.get({accountId: 'bob'}), hasCode('UNAUTHENTICATED'));
  await assert.rejects(f.admin.policies.set(policy()), hasCode('UNAUTHENTICATED'));
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_compute_policies WHERE account_id='bob'").get().n, 0);
});

test('lost policy response is not retried and current state can be queried independently', async t => {
  const f = await fixture(t);
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl, session: f.admin.policies.transport.session,
    fetch: async (url, options) => {await fetch(url, options); throw new Error('lost response');}});
  await assert.rejects(new ComputePolicyClient({transport}).set(policy()), hasCode('NETWORK_UNAVAILABLE'));
  assert.deepEqual(await f.admin.policies.get({accountId: 'bob'}), {...policy(), revision: 1});
  assert.equal(f.calls.filter(path => path === '/api/v2/compute-policy/set').length, 1);
});
