import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openClientCredentials} from '../src/infrastructure/open-client-credentials.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {sessionFixture, loginRequest, readRequest} from './helpers/v2-session-fixture.mjs';
import {SESSION_ROUTES} from '../src/contracts/session.mjs';

const run = promisify(execFile), hasCode = code => error => error.code === code;
async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'v2-client-store-'));
  const path = join(directory, 'credentials.sqlite');
  const handles = [];
  const open = () => {const handle = openClientCredentials(path); handles.push(handle); return handle;};
  t.after(async () => {
    for (const handle of handles) handle.close();
    await rm(directory, {recursive: true, force: true});
  });
  return {path, open};
}
function client(baseUrl, credentials, fetch = globalThis.fetch) {
  const transport = new JsonHttpTransport({baseUrl, fetch});
  transport.session.close();
  return {transport, session: new SessionClient({transport, delivery: 'token', credentials}), data: new DataClient({transport})};
}

test('private local credentials persist by origin and a stale clear cannot delete a newer process token', async t => {
  const f = await storeFixture(t), first = f.open();
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  first.credentials.save('https://one.example', 'a'.repeat(64));
  first.credentials.save('https://two.example', 'b'.repeat(64));
  const second = f.open();
  assert.equal(second.credentials.load('https://one.example'), 'a'.repeat(64));
  const moduleUrl = new URL('../src/infrastructure/open-client-credentials.mjs', import.meta.url).href;
  await run(process.execPath, ['--input-type=module', '-e', `
    const {openClientCredentials} = await import(process.argv[1]);
    const store = openClientCredentials(process.argv[2]);
    store.credentials.save('https://one.example', 'c'.repeat(64));
    store.close();
  `, moduleUrl, f.path]);
  first.credentials.remove('https://one.example', 'a'.repeat(64));
  assert.equal(second.credentials.load('https://one.example'), 'c'.repeat(64));
  assert.equal(second.credentials.load('https://two.example'), 'b'.repeat(64));
  second.credentials.remove('https://one.example', 'c'.repeat(64));
  assert.equal(first.credentials.load('https://one.example'), null);
});

test('opening an existing world-readable credential file refuses to store secrets', async t => {
  const f = await storeFixture(t);
  f.open();
  await chmod(f.path, 0o644);
  assert.throws(() => openClientCredentials(f.path), /must be private/);
});

test('new CLI client restores saved token through the server, and confirmed logout removes it', async t => {
  const f = await sessionFixture(); t.after(() => f.close());
  const files = await storeFixture(t), first = client(f.baseUrl, files.open().credentials);
  const identity = await first.session.login(loginRequest);
  const restarted = client(f.baseUrl, files.open().credentials);
  assert.deepEqual(await restarted.session.restore(), identity);
  assert.equal((await restarted.data.resolveReadLocation(readRequest)).availability, 'available');
  await restarted.session.logout();
  assert.equal(files.open().credentials.load(f.baseUrl), null);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 1);
});

test('offline restore retains the saved token; explicit revoked response discards only that token', async t => {
  const f = await sessionFixture(); t.after(() => f.close());
  const files = await storeFixture(t), store = files.open().credentials;
  await client(f.baseUrl, store).session.login(loginRequest);
  const token = store.load(f.baseUrl);
  const offline = client(f.baseUrl, store, async () => {throw new Error('offline');});
  await assert.rejects(offline.session.restore(), hasCode('NETWORK_UNAVAILABLE'));
  assert.equal(store.load(f.baseUrl), token);
  f.database.exec('UPDATE v2_sessions SET revoked=1');
  await assert.rejects(client(f.baseUrl, store).session.restore(), hasCode('UNAUTHENTICATED'));
  assert.equal(store.load(f.baseUrl), null);
});

test('logout receipt loss keeps recovery credentials and never becomes a successful local-only logout', async t => {
  const f = await sessionFixture(); t.after(() => f.close());
  const files = await storeFixture(t), store = files.open().credentials;
  const original = client(f.baseUrl, store, async (url, options) => {
    const response = await fetch(url, options);
    if (url.pathname === SESSION_ROUTES.logout) throw new Error('lost receipt');
    return response;
  });
  await original.session.login(loginRequest);
  const token = store.load(f.baseUrl);
  await assert.rejects(original.session.logout(), hasCode('NETWORK_UNAVAILABLE'));
  assert.equal(store.load(f.baseUrl), token);
  assert.equal(original.transport.session.snapshot().signal.aborted, true);
  // This particular server did revoke it; a fresh observation proves that.
  await assert.rejects(client(f.baseUrl, store).session.restore(), hasCode('UNAUTHENTICATED'));
  assert.equal(store.load(f.baseUrl), null);
});

test('old process logout leaves a newer login credential intact', async t => {
  const f = await sessionFixture(); t.after(() => f.close());
  const files = await storeFixture(t), store = files.open().credentials;
  const first = client(f.baseUrl, store), second = client(f.baseUrl, files.open().credentials);
  await first.session.login(loginRequest);
  await second.session.login(loginRequest);
  const newToken = store.load(f.baseUrl);
  await first.session.logout();
  assert.equal(store.load(f.baseUrl), newToken);
  await second.session.restore();
});

test('storage failures do not claim persistent login success or silently fall back to a different store', async t => {
  const f = await sessionFixture(); t.after(() => f.close());
  let writes = 0;
  const store = {save() {writes++; throw new Error('disk full');}};
  const current = client(f.baseUrl, store);
  await assert.rejects(current.session.login(loginRequest), hasCode('CREDENTIAL_SAVE_FAILED'));
  assert.equal(writes, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 1);
  // The server-side login happened; memory remains usable, persistence failed.
  assert.equal((await current.data.resolveReadLocation(readRequest)).availability, 'available');
  assert.throws(() => new SessionClient({transport: current.transport, delivery: 'cookie', credentials: store}), hasCode('INVALID_SESSION_DELIVERY'));
});
