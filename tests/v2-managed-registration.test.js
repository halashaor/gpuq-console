import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {publishedFixture} from './helpers/v2-published-fixture.mjs';
import {createManagedRegistrationSchema} from '../src/infrastructure/sqlite/managed-registrations.mjs';
import {assembleSqliteManagedRegistration} from '../src/bootstrap/sqlite-managed-registration.mjs';
import {assembleSqliteDataRead} from '../src/bootstrap/sqlite-data-read.mjs';
import {ManagedRegistrationClient} from '../src/client/managed-registration-client.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {ClientSession} from '../src/client/session.mjs';
import {parseManagedRegistration} from '../src/contracts/managed-registration.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  const publication = await publishedFixture(t);
  createManagedRegistrationSchema(f.database);
  const loginTransport = new JsonHttpTransport({baseUrl: f.baseUrl});
  await new SessionClient({transport: loginTransport, delivery: 'token'}).login(loginRequest);
  let registerHandler, readHandler, calls = 0;
  const sources = {inspect(...args) {calls++; return publication.managed.inspect(...args);}};
  const modules = new Map(['client/managed-registration-client.mjs', 'client/http-transport.mjs', 'client/session.mjs', 'client/errors.mjs',
    'contracts/managed-registration.mjs', 'contracts/data-read.mjs', 'contracts/errors.mjs']
    .map(name => ['/modules/' + name, new URL('../src/' + name, import.meta.url)]));
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>Managed registration</title>');}
    else if (modules.has(req.url)) {res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end(await readFile(modules.get(req.url)));}
    else if (req.url === '/api/v2/data/register-managed') await registerHandler(req, res);
    else await readHandler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const common = {database: f.database, publicOrigin: origin, reportError() {}};
  registerHandler = assembleSqliteManagedRegistration({...common, sources, configuredVersions:
    ['cache', 'warehouse'].map(kind => ({...publication.request(kind), ownerId: 'alice', visibility: 'private'}))});
  readHandler = assembleSqliteDataRead({...common, sources});
  const transport = new JsonHttpTransport({baseUrl: origin, session: new ClientSession({headers: loginTransport.session.snapshot().headers})});
  return {...f, ...publication, origin, transport, sources, calls: () => calls,
    registration: new ManagedRegistrationClient({transport}), data: new DataClient({transport})};
}

test('real published cache and warehouse register one version identity and are checked again for reads', async t => {
  const f = await fixture(t);
  const cache = await f.registration.register(f.request('cache'));
  const warehouse = await f.registration.register(f.request('warehouse'));
  assert.equal(cache.resourceId, warehouse.resourceId);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_managed_bindings').get().n, 2);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_source_bindings').get().n, 1, 'no fake path/READY entry is added');
  const before = f.calls();
  for (const kind of ['cache', 'warehouse']) assert.equal((await f.data.resolveReadLocation(f.request(kind))).availability, 'available');
  assert.equal(f.calls(), before + 2);
  f.sources.inspect = async () => ({availability: 'unavailable', reason: 'not-ready'});
  assert.equal((await f.data.resolveReadLocation(f.request('cache'))).availability, 'unavailable');
});

test('concurrent identical registration is idempotent without resetting ACLs', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.registration.register(f.request('cache')), f.registration.register(f.request('cache'))]);
  assert.deepEqual(a, b);
  f.database.prepare('UPDATE v2_data_resources SET acl_revision=5 WHERE id=?').run(a.resourceId);
  await f.registration.register(f.request('warehouse'));
  assert.equal(f.database.prepare('SELECT acl_revision FROM v2_data_resources WHERE id=?').get(a.resourceId).acl_revision, 5);
});

test('unconfigured versions, caller ownership and unready observations do not register a source', async t => {
  const f = await fixture(t), request = f.request('cache');
  await assert.rejects(f.registration.register({...request, source: {...request.source, version: '0'.repeat(64)}}), hasCode('SOURCE_NOT_CONFIGURED'));
  assert.equal(f.calls(), 0);
  f.database.exec("UPDATE v2_accounts SET role='member' WHERE id='alice'");
  await assert.rejects(f.registration.register(request), hasCode('FORBIDDEN'));
  assert.equal(f.calls(), 0);
  f.database.exec("UPDATE v2_accounts SET role='admin' WHERE id='alice'");
  assert.throws(() => parseManagedRegistration({...request, ownerId: 'bob'}), hasCode('INVALID_REQUEST'));
  f.sources.inspect = async () => ({availability: 'unavailable', reason: 'not-ready'});
  await assert.rejects(f.registration.register(request), hasCode('SOURCE_NOT_READY'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_managed_bindings').get().n, 0);
});

test('revocation during native inspection prevents committing metadata', async t => {
  const f = await fixture(t);
  f.sources.inspect = async () => {
    f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
    return {availability: 'available'};
  };
  await assert.rejects(f.registration.register(f.request('cache')), hasCode('UNAUTHENTICATED'));
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_data_resources WHERE kind='dataset'").get().n, 0);
});

test('binding insert failure rolls back version creation; conflicting ownership is never adopted', async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER fail_managed BEFORE INSERT ON v2_managed_bindings BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(f.registration.register(f.request('cache')), hasCode('INTERNAL_ERROR'));
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_data_resources WHERE kind='dataset'").get().n, 0);
  f.database.exec('DROP TRIGGER fail_managed');
  const registered = await f.registration.register(f.request('cache'));
  f.database.prepare("UPDATE v2_data_resources SET visibility='shared' WHERE id=?").run(registered.resourceId);
  await assert.rejects(f.registration.register(f.request('warehouse')), hasCode('SOURCE_REGISTRATION_CONFLICT'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_managed_bindings').get().n, 1);
});

test('real browser Cookie and Node Bearer use the same managed registration SDK and immutable identity', async t => {
  const f = await fixture(t), browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    await context.addCookies([{name: 'gpuq_session', value: f.transport.session.snapshot().headers.Authorization.slice(7),
      url: f.origin, httpOnly: true, sameSite: 'Strict'}]);
    const page = await context.newPage();
    await page.goto(f.origin);
    const browserResult = await page.evaluate(async request => {
      const {ManagedRegistrationClient} = await import('/modules/client/managed-registration-client.mjs');
      const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
      return new ManagedRegistrationClient({transport: new JsonHttpTransport({baseUrl: location.origin})}).register(request);
    }, f.request('warehouse'));
    assert.deepEqual(browserResult, await f.registration.register(f.request('warehouse')));
    assert.equal((await f.data.resolveReadLocation(f.request('warehouse'))).availability, 'available');
  } finally {await browser.close();}
});
