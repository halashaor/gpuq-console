import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {AccountClient} from '../src/client/account-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SqliteAccounts} from '../src/infrastructure/sqlite/accounts.mjs';
import {parseAccountChange} from '../src/contracts/account.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  f.database.exec(`UPDATE v2_accounts SET role='admin' WHERE id='alice';
    INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  async function login(username) {
    const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
    const session = new SessionClient({transport, delivery: 'token'});
    await session.login({...loginRequest, username});
    return {session, accounts: new AccountClient({transport}), transport};
  }
  return {...f, admin: await login('alice'), member: await login('bob'), login};
}
const role = (accountId, revision, value) => ({accountId, revision, kind: 'role', role: value});
const enabled = (accountId, revision, value) => ({accountId, revision, kind: 'enabled', enabled: value});

test('administrator changes role atomically and invalidates the target previous session', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.admin.accounts.change(role('bob', 0, 'admin')), {id: 'bob', role: 'admin', enabled: true, revision: 1});
  await assert.rejects(f.member.session.refresh(), hasCode('UNAUTHENTICATED'));
  const fresh = await f.login('bob');
  assert.equal((await fresh.session.restore({credential: fresh.transport.session.snapshot().headers.Authorization.slice(7)})).account.role, 'admin');
  await assert.rejects(f.admin.accounts.change(role('bob', 0, 'member')), hasCode('ACCOUNT_CHANGED'));
  assert.equal(f.database.prepare("SELECT role FROM v2_accounts WHERE id='bob'").get().role, 'admin');
});

test('ordinary members cannot change themselves or probe another account through writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.member.accounts.change(role('bob', 0, 'admin')), hasCode('FORBIDDEN'));
  await assert.rejects(f.member.accounts.change(role('missing', 0, 'admin')), hasCode('FORBIDDEN'));
  assert.equal(f.database.prepare("SELECT auth_revision FROM v2_accounts WHERE id='bob'").get().auth_revision, 0);
});

test('last administrator and own role/disable protections match existing behavior', async t => {
  const f = await fixture(t);
  await assert.rejects(f.admin.accounts.change(role('alice', 0, 'member')), hasCode('LAST_ADMIN'));
  await assert.rejects(f.admin.accounts.change(enabled('alice', 0, false)), hasCode('LAST_ADMIN'));
  await f.admin.accounts.change(role('bob', 0, 'admin'));
  await assert.rejects(f.admin.accounts.change(role('alice', 0, 'member')), hasCode('SELF_ACCOUNT_CHANGE'));
  await assert.rejects(f.admin.accounts.change(enabled('alice', 0, false)), hasCode('SELF_ACCOUNT_CHANGE'));
});

test('disable/re-enable cannot revive old sessions; repeated enabled=true is a no-op', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin.accounts.change(enabled('bob', 0, true))).revision, 0);
  await f.member.session.refresh();
  assert.equal((await f.admin.accounts.change(enabled('bob', 0, false))).revision, 1);
  await assert.rejects(f.member.session.refresh(), hasCode('UNAUTHENTICATED'));
  await assert.rejects(f.login('bob'), hasCode('INVALID_CREDENTIALS'));
  await f.admin.accounts.change(enabled('bob', 1, true));
  await assert.rejects(f.member.session.refresh(), hasCode('UNAUTHENTICATED'));
  await f.login('bob');
});

test('write transaction rechecks revoked administrator and rolls back injected storage failure', async t => {
  const f = await fixture(t);
  const sessionId = f.database.prepare("SELECT id FROM v2_sessions WHERE account_id='alice'").get().id;
  const writer = new SqliteAccounts({database: f.database});
  f.database.prepare('UPDATE v2_sessions SET revoked=1 WHERE id=?').run(sessionId);
  assert.throws(() => writer.change({id: 'alice', sessionId}, role('bob', 0, 'admin'), Date.now()), hasCode('UNAUTHENTICATED'));
  f.database.prepare('UPDATE v2_sessions SET revoked=0 WHERE id=?').run(sessionId);
  f.database.exec("CREATE TRIGGER fail_account BEFORE UPDATE ON v2_accounts BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
  await assert.rejects(f.admin.accounts.change(role('bob', 0, 'admin')), hasCode('INTERNAL_ERROR'));
  const row = f.database.prepare("SELECT role,auth_revision FROM v2_accounts WHERE id='bob'").get();
  assert.equal(row.role, 'member'); assert.equal(row.auth_revision, 0);
  await f.member.session.refresh();
  assert.equal(f.errors.length, 1);
});

test('concurrent administrator writes against the same revision produce one success', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([
    f.admin.accounts.change(role('bob', 0, 'admin')),
    f.admin.accounts.change(enabled('bob', 0, false)),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'ACCOUNT_CHANGED');
  assert.equal(f.database.prepare("SELECT auth_revision FROM v2_accounts WHERE id='bob'").get().auth_revision, 1);
});

test('account contract accepts only explicit changes and never caller identity', () => {
  for (const input of [{...role('bob', 0, 'admin'), actor: 'alice'}, role('bob', -1, 'admin'), role('bob', 0, 'root'), enabled('bob', 0, 'false')]) {
    assert.throws(() => parseAccountChange(input), hasCode('INVALID_REQUEST'));
  }
});

test('lost write receipt is resolved through a fresh account read, not an automatic replay', async t => {
  const f = await fixture(t);
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl, session: f.admin.transport.session, fetch: async (url, options) => {
    await fetch(url, options);
    throw new Error('response lost');
  }});
  await assert.rejects(new AccountClient({transport}).change(role('bob', 0, 'admin')), hasCode('NETWORK_UNAVAILABLE'));
  assert.deepEqual(await f.admin.accounts.get({accountId: 'bob'}), {id: 'bob', role: 'admin', enabled: true, revision: 1});
  assert.equal(f.calls.filter(path => path === '/api/v2/accounts/change').length, 1);
  await assert.rejects(f.member.accounts.get({accountId: 'alice'}), hasCode('UNAUTHENTICATED'));
  await assert.rejects(f.admin.accounts.get({accountId: 'missing'}), hasCode('ACCOUNT_NOT_FOUND'));
});
