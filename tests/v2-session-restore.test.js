import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFixture, loginRequest, readRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SESSION_ROUTES} from '../src/contracts/session.mjs';
import {SessionLifecycle} from '../src/application/session-lifecycle.mjs';
import {SqliteLoginSessions} from '../src/infrastructure/sqlite/login-repositories.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture();
  t.after(() => f.close());
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
  const session = new SessionClient({transport, delivery: 'token'});
  await session.login(loginRequest);
  const credential = transport.session.snapshot().headers.Authorization.slice(7);
  return {...f, credential, transport, session};
}
function restoredClient(f, fetch = globalThis.fetch) {
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl, fetch});
  transport.session.close();
  return {transport, session: new SessionClient({transport, delivery: 'token'}), data: new DataClient({transport})};
}

test('restoration queries current profile, does not sign in or renew, and then enables business requests', async t => {
  const f = await fixture(t), client = restoredClient(f);
  const before = {...f.database.prepare('SELECT * FROM v2_sessions').get()};
  f.database.exec("UPDATE v2_accounts SET display_name='Updated name' WHERE id='alice'");
  const result = await client.session.restore({credential: f.credential});
  assert.deepEqual(result, {account: {id: 'alice', username: 'alice', displayName: 'Updated name', role: 'member'}, expiresAtMs: before.expires_at_ms});
  assert.deepEqual({...f.database.prepare('SELECT * FROM v2_sessions').get()}, before);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 1);
  assert.equal((await client.data.resolveReadLocation(readRequest)).availability, 'available');
  assert.equal(f.calls.filter(path => path === SESSION_ROUTES.login).length, 1);
});

test('revoked, expired, disabled and revision-stale credentials cannot reopen a client', async t => {
  for (const change of [
    'UPDATE v2_sessions SET revoked=1',
    'UPDATE v2_sessions SET expires_at_ms=1',
    'UPDATE v2_accounts SET enabled=0',
    'UPDATE v2_accounts SET auth_revision=auth_revision+1',
  ]) {
    const f = await fixture(t), client = restoredClient(f);
    f.database.exec(change);
    await assert.rejects(client.session.restore({credential: f.credential}), hasCode('UNAUTHENTICATED'));
    await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
    assert.deepEqual(client.transport.session.snapshot().headers, {});
  }
});

test('restoration failures remain distinct; network or malformed reply is not an invalid-password result', async t => {
  const f = await fixture(t);
  for (const [fetch, code] of [
    [async () => {throw new Error('offline');}, 'NETWORK_UNAVAILABLE'],
    [async () => new Response(JSON.stringify({result: {account: {role: 'admin'}}})), 'INVALID_API_RESPONSE'],
  ]) {
    const client = restoredClient(f, fetch);
    await assert.rejects(client.session.restore({credential: f.credential}), hasCode(code));
    await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
  }
  // Failed observations did not revoke the original session.
  await f.session.refresh();
});

test('late restore cannot overwrite a replacement identity and pending restore does not permit data calls', async t => {
  const f = await fixture(t);
  let arrived, release;
  const entered = new Promise(resolve => arrived = resolve), held = new Promise(resolve => release = resolve);
  const client = restoredClient(f, async (url, options) => {
    const response = await fetch(url, options);
    arrived(); await held; return response;
  });
  const pending = client.session.restore({credential: f.credential});
  await entered;
  await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
  await assert.rejects(client.session.login(loginRequest), hasCode('SESSION_BUSY'));
  client.transport.session.replace({headers: {Authorization: 'Bearer ' + 'c'.repeat(64)}});
  release();
  await assert.rejects(pending, hasCode('SESSION_CHANGED'));
  assert.equal(client.transport.session.snapshot().headers.Authorization, 'Bearer ' + 'c'.repeat(64));
});

test('current identity is owner-scoped and rechecks revocation after HTTP authentication', async t => {
  const f = await fixture(t);
  const row = f.database.prepare('SELECT id FROM v2_sessions').get();
  const lifecycle = new SessionLifecycle({sessions: new SqliteLoginSessions({database: f.database})});
  await assert.rejects(lifecycle.current({id: 'other', sessionId: row.id}), hasCode('UNAUTHENTICATED'));
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  await assert.rejects(lifecycle.current({id: 'alice', sessionId: row.id}), hasCode('UNAUTHENTICATED'));
});

test('restoration rejects absent CLI token or explicit browser token without an HTTP request', async t => {
  const f = await fixture(t), client = restoredClient(f), count = f.calls.length;
  await assert.rejects(client.session.restore(), hasCode('INVALID_SESSION_CREDENTIAL'));
  const browser = new SessionClient({transport: client.transport, delivery: 'cookie'});
  await assert.rejects(browser.restore({credential: f.credential}), hasCode('INVALID_SESSION_CREDENTIAL'));
  assert.equal(f.calls.length, count);
});
