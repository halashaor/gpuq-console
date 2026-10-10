import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFixture, loginRequest, readRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SESSION_ROUTES, parseLoginRequest, parseLoginResult} from '../src/contracts/session.mjs';
import {SESSION_POLICY} from '../src/domain/session-policy.mjs';
import {createSessionHandler} from '../src/api/session-handler.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture();
  t.after(() => f.close());
  return f;
}
function sdk(f, fetch = globalThis.fetch) {
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl, fetch});
  return {transport, session: new SessionClient({transport, delivery: 'token'}), data: new DataClient({transport})};
}
const post = (f, path, body, headers = {}) => fetch(f.baseUrl + path, {
  method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body),
});

test('Node SDK login, protected read, sliding refresh, logout and relogin share SQLite authority', async t => {
  const f = await fixture(t), client = sdk(f);
  const logged = await client.session.login(loginRequest);
  assert.deepEqual(logged.account, {id: 'alice', username: 'alice', displayName: 'Alice', role: 'member'});
  assert.equal(Object.hasOwn(logged, 'credential'), false);
  const header = client.transport.session.snapshot().headers.Authorization;
  assert.match(header, /^Bearer [a-f0-9]{64}$/);
  assert.equal((await client.data.resolveReadLocation(readRequest)).availability, 'available');
  f.advance(SESSION_POLICY.touchMs);
  assert.equal((await client.session.refresh()).expiresAtMs, logged.expiresAtMs + SESSION_POLICY.touchMs);
  assert.deepEqual(await client.session.logout(), {revoked: true});
  const calls = f.calls.length;
  await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
  assert.equal(f.calls.length, calls);
  assert.equal((await post(f, SESSION_ROUTES.refresh, {}, {Authorization: header})).status, 401);
  await client.session.login(loginRequest);
  assert.equal((await client.data.resolveReadLocation(readRequest)).availability, 'available');
  assert.deepEqual(f.errors, []);
});

test('cookie delivery omits token from JSON, requires same origin and logout clears only cookie sessions', async t => {
  const f = await fixture(t);
  const input = {...loginRequest, delivery: 'cookie'};
  assert.equal((await post(f, SESSION_ROUTES.login, input)).status, 403);
  assert.equal((await post(f, SESSION_ROUTES.login, input, {Origin: 'https://other.invalid'})).status, 403);
  assert.equal((await post(f, SESSION_ROUTES.login, {...input, delivery: 'token'}, {Origin: 'https://other.invalid'})).status, 403);
  const response = await post(f, SESSION_ROUTES.login, input, {Origin: f.baseUrl});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(Object.hasOwn(payload.result, 'credential'), false);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=31536000/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const headers = {Cookie: setCookie.split(';')[0], Origin: f.baseUrl};
  assert.equal((await post(f, SESSION_ROUTES.refresh, {}, headers)).status, 200);
  assert.equal((await post(f, SESSION_ROUTES.refresh, {}, {...headers, Authorization: 'Bearer invalid'})).status, 401);
  const logout = await post(f, SESSION_ROUTES.logout, {}, headers);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await post(f, SESSION_ROUTES.refresh, {}, headers)).status, 401);
});

test('HTTP request bounds reject actor injection, malformed bodies and wrong methods before signing in', async t => {
  const f = await fixture(t);
  const input = {...loginRequest, delivery: 'token'};
  for (const body of [{...input, actor: 'admin'}, {...input, password: 'x'.repeat(9000)}, null]) {
    assert.equal((await post(f, SESSION_ROUTES.login, body)).status, 400);
  }
  assert.equal((await fetch(f.baseUrl + SESSION_ROUTES.login)).status, 405);
  assert.equal((await fetch(f.baseUrl + SESSION_ROUTES.login, {method: 'POST', body: '{}'})).status, 415);
  assert.equal((await post(f, '/api/v2/session/unknown', {})).status, 404);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 0);
});

test('failed identity change keeps business requests closed instead of reusing a previous identity', async t => {
  const f = await fixture(t), client = sdk(f);
  await client.session.login(loginRequest);
  await assert.rejects(client.session.login({...loginRequest, password: 'wrong'}), hasCode('INVALID_CREDENTIALS'));
  await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
  assert.deepEqual(client.transport.session.snapshot().headers, {});
});

test('lost logout receipt is not reported as success and is never retried', async t => {
  const f = await fixture(t);
  let losses = 0;
  const client = sdk(f, async (url, options) => {
    const response = await fetch(url, options);
    if (url.pathname === SESSION_ROUTES.logout) { losses++; throw new Error('lost response'); }
    return response;
  });
  await client.session.login(loginRequest);
  const header = client.transport.session.snapshot().headers.Authorization;
  await assert.rejects(client.session.logout(), hasCode('NETWORK_UNAVAILABLE'));
  assert.equal(losses, 1);
  await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
  assert.equal((await post(f, SESSION_ROUTES.refresh, {}, {Authorization: header})).status, 401);
});

test('SDK serializes identity changes and does not install a late login over an externally closed session', async t => {
  const f = await fixture(t);
  let release, arrived;
  const held = new Promise(resolve => release = resolve), entered = new Promise(resolve => arrived = resolve);
  const client = sdk(f, async (url, options) => {
    const response = await fetch(url, options);
    arrived(); await held; return response;
  });
  const login = client.session.login(loginRequest);
  await entered;
  await assert.rejects(client.session.logout(), hasCode('SESSION_BUSY'));
  await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
  client.transport.session.close();
  release();
  await assert.rejects(login, hasCode('SESSION_CHANGED'));
  assert.deepEqual(client.transport.session.snapshot().headers, {});
});

test('shared session contract preserves password bytes and rejects secret-bearing browser results', () => {
  assert.equal(parseLoginRequest({username: ' alice ', password: ' spaces ', delivery: 'cookie'}).password, ' spaces ');
  assert.equal(parseLoginRequest({username: ' alice ', password: ' spaces ', delivery: 'cookie'}).username, 'alice');
  assert.throws(() => parseLoginResult({account: {}, expiresAtMs: 100, credential: 'a'.repeat(64)}, 'cookie'), hasCode('INVALID_API_RESPONSE'));
});

test('malformed login success cannot reopen business requests or install credentials', async t => {
  const f = await fixture(t);
  const client = sdk(f, async () => new Response(JSON.stringify({result: {
    account: {id: 'alice', username: 'alice', displayName: 'Alice', role: 'member'},
    expiresAtMs: 100, credential: 'not-a-token',
  }}), {status: 200}));
  await assert.rejects(client.session.login(loginRequest), hasCode('INVALID_API_RESPONSE'));
  await assert.rejects(client.data.resolveReadLocation(readRequest), hasCode('SESSION_CLOSED'));
  assert.deepEqual(client.transport.session.snapshot().headers, {});
});

test('late logout failure does not close an externally replaced client identity', async t => {
  const f = await fixture(t);
  let arrived, release;
  const entered = new Promise(resolve => arrived = resolve), held = new Promise(resolve => release = resolve);
  const client = sdk(f, async (url, options) => {
    const response = await fetch(url, options);
    if (url.pathname === SESSION_ROUTES.logout) { arrived(); await held; }
    return response;
  });
  await client.session.login(loginRequest);
  const logout = client.session.logout();
  await entered;
  client.transport.session.replace({headers: {Authorization: 'Bearer ' + 'b'.repeat(64)}});
  release();
  await assert.rejects(logout, hasCode('SESSION_CHANGED'));
  const snapshot = client.transport.session.snapshot();
  assert.equal(snapshot.signal.aborted, false);
  assert.equal(snapshot.headers.Authorization, 'Bearer ' + 'b'.repeat(64));
});

test('HTTPS login cookies are secure; unsafe public origins fail composition', async () => {
  const handler = createSessionHandler({publicOrigin: 'https://portal.example', login: {execute: async () => ({
    account: {id: 'alice'}, expiresAtMs: 100, credential: 'a'.repeat(64),
  })}});
  let headers;
  const body = Buffer.from(JSON.stringify({...loginRequest, delivery: 'cookie'}));
  await handler({url: SESSION_ROUTES.login, method: 'POST', headers: {'content-type': 'application/json', origin: 'https://portal.example'},
    iterator: async function* () { yield body; }}, {writeHead: (_, value) => headers = value, end() {}});
  assert.match(headers['Set-Cookie'], /; Secure$/);
  assert.throws(() => createSessionHandler({publicOrigin: 'http://portal.example'}), /Invalid public origin/);
});
