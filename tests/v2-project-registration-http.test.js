import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {projectFixture, python} from './helpers/v2-project-fixture.mjs';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {assembleProjectInspection} from '../src/bootstrap/project-inspection.mjs';
import {assembleSqliteProjectRegistration} from '../src/bootstrap/sqlite-project-registration.mjs';
import {assembleSqliteSession} from '../src/bootstrap/sqlite-session.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {HttpProjectReader} from '../src/infrastructure/http-project-reader.mjs';
import {ProjectClient} from '../src/client/project-client.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {PROJECT_REGISTRATION_ROUTES} from '../src/contracts/project-registration.mjs';

const hasCode = code => error => error.code === code;
async function server(t, handler) {
  const value = http.createServer(handler);
  await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  const close = async () => {if (value.listening) {value.closeAllConnections(); await new Promise(resolve => value.close(resolve));}};
  t.after(close);
  return {origin: `http://127.0.0.1:${value.address().port}`, close};
}
async function fixture(t) {
  const p = await projectFixture(t), f = await sessionFixture(); t.after(() => f.close());
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  const credential = 'c'.repeat(64);
  let nodeCalls = 0, registrationHandler, sessionHandler;
  const inspect = assembleProjectInspection({machineId: 'node-1', root: p.root, basePath: p.basePath, python, credential});
  const node = await server(t, (req, res) => {nodeCalls++; return inspect(req, res);});
  const modules = new Map(['client/project-client.mjs', 'client/http-transport.mjs', 'client/session.mjs', 'client/errors.mjs',
    'contracts/project-registration.mjs', 'contracts/project-inspection.mjs', 'contracts/errors.mjs']
    .map(name => ['/modules/' + name, new URL('../src/' + name, import.meta.url)]));
  const portal = await server(t, async (req, res) => {
    if (req.url === '/') {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>Project registration</title>');}
    else if (modules.has(req.url)) {res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end(await readFile(modules.get(req.url)));}
    else if (req.url.startsWith('/api/v2/projects/')) await registrationHandler(req, res);
    else await sessionHandler(req, res);
  });
  const common = {database: f.database, publicOrigin: portal.origin, reportError() {}};
  registrationHandler = assembleSqliteProjectRegistration({...common, projects: new HttpProjectReader({nodes: [{machineId: 'node-1', origin: node.origin, credential}]})});
  sessionHandler = assembleSqliteSession(common);
  const transport = new JsonHttpTransport({baseUrl: portal.origin});
  await new SessionClient({transport, delivery: 'token'}).login(loginRequest);
  return {...p, database: f.database, origin: portal.origin, transport, node,
    reference: {...p.request, projectId: 'logical-project'}, client: new ProjectClient({transport}), calls: () => nodeCalls};
}

test('project register/query API uses real node metadata and stored lookup makes no node call', async t => {
  const f = await fixture(t);
  assert.equal(await f.client.registration(f.reference), null);
  assert.equal(f.calls(), 0);
  const registered = await f.client.registerRelease(f.reference);
  assert.equal(registered.registered, true); assert.equal(registered.runtimeVerified, false);
  assert.equal(f.calls(), 1);
  assert.deepEqual(await f.client.registration(f.reference), registered);
  assert.equal(f.calls(), 1);
  await assert.rejects(f.client.registration({...f.reference, project: 'wrong-slug'}), hasCode('PROJECT_INSTANCE_CONFLICT'));
  f.database.exec("DELETE FROM v2_machine_grants WHERE account_id='alice'");
  assert.deepEqual(await f.client.registration(f.reference), registered, 'owner may inspect its stored registration after machine access changes');
  await assert.rejects(f.client.registerRelease(f.reference), hasCode('FORBIDDEN'));
  assert.equal(f.calls(), 1, 'stored lookup does not confer permission for a new node operation');
});

test('response loss is resolved from the original reference even when the node goes offline', async t => {
  const f = await fixture(t);
  const transport = new JsonHttpTransport({baseUrl: f.origin, session: f.transport.session, fetch: async (url, options) => {
    await fetch(url, options); throw new Error('lost registration response');
  }});
  await assert.rejects(new ProjectClient({transport}).registerRelease(f.reference), hasCode('NETWORK_UNAVAILABLE'));
  await f.node.close();
  const stored = await f.client.registration(f.reference);
  assert.equal(stored.registered, true); assert.equal(stored.runtimeVerified, false);
  assert.equal(f.calls(), 1);
});

test('identity/path injection and cross-account catalogue lookup do not expose or query a private project', async t => {
  const f = await fixture(t);
  const post = body => fetch(f.origin + PROJECT_REGISTRATION_ROUTES.register, {method: 'POST',
    headers: {...f.transport.session.snapshot().headers, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal((await post({...f.reference, accountId: 'bob'})).status, 400);
  assert.equal((await post({...f.reference, root: '/private'})).status, 400);
  assert.equal(f.calls(), 0);
  await f.client.registerRelease(f.reference);
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  const other = new JsonHttpTransport({baseUrl: f.origin});
  await new SessionClient({transport: other, delivery: 'token'}).login({...loginRequest, username: 'bob'});
  await assert.rejects(new ProjectClient({transport: other}).registration(f.reference), hasCode('FORBIDDEN'));
  assert.equal(f.calls(), 1);
});

test('real browser and Node use the same project registration SDK', async t => {
  const f = await fixture(t), browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    await context.addCookies([{name: 'gpuq_session', value: f.transport.session.snapshot().headers.Authorization.slice(7), url: f.origin, httpOnly: true, sameSite: 'Strict'}]);
    const page = await context.newPage(); await page.goto(f.origin);
    const result = await page.evaluate(async request => {
      const {ProjectClient} = await import('/modules/client/project-client.mjs');
      const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
      return new ProjectClient({transport: new JsonHttpTransport({baseUrl: location.origin})}).registerRelease(request);
    }, f.reference);
    assert.deepEqual(await f.client.registration(f.reference), result);
  } finally {await browser.close();}
});

test('real CLI can register and recover the same project reference across processes', async t => {
  const f = await fixture(t);
  const run = (args, input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/v2-client.mjs', import.meta.url)), ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr})); child.stdin.end(input);
  });
  const args = ['--url', f.origin, '--credentials', join(f.directory, 'cli.sqlite')];
  const login = await run([...args, 'login', '--username', 'alice', '--password-stdin'], loginRequest.password);
  assert.equal(login.code, 0, login.stderr);
  const ref = ['--project-id', f.reference.projectId, '--machine', 'node-1', '--project', 'training', '--release', f.release];
  const registered = await run([...args, 'register-project', ...ref]); assert.equal(registered.code, 0, registered.stderr);
  const lookup = await run([...args, 'project-registration', ...ref]); assert.equal(lookup.code, 0, lookup.stderr);
  assert.deepEqual(JSON.parse(lookup.stdout), JSON.parse(registered.stdout));
});
