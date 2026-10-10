import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {projectFixture, python} from './helpers/v2-project-fixture.mjs';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {assembleProjectInspection} from '../src/bootstrap/project-inspection.mjs';
import {HttpProjectReader} from '../src/infrastructure/http-project-reader.mjs';
import {NodeJsonTransport} from '../src/infrastructure/node-json-transport.mjs';
import {PROJECT_INSPECTION_ROUTE} from '../src/contracts/project-inspection.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema, SqliteProjectRegistrations} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';

const credential = 'c'.repeat(64), context = {actor: {id: 'alice'}}, hasCode = code => error => error.code === code;
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('remote project observation and registration use actual node/Python metadata with the same instance identity', async t => {
  const p = await projectFixture(t), f = await sessionFixture(); t.after(() => f.close());
  const origin = await serve(t, assembleProjectInspection({machineId: 'node-1', credential, root: p.root, basePath: p.basePath, python}));
  const projects = new HttpProjectReader({nodes: [{machineId: 'node-1', origin, credential}]});
  const observed = await projects.inspect(p.request, context);
  assert.deepEqual(observed, await p.reader.inspect(p.request, context));
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id};
  const app = new RegisterProjectRelease({registrations: new SqliteProjectRegistrations({database: f.database}), projects});
  const registered = await app.execute(actor, {...p.request, projectId: 'logical'});
  assert.equal(registered.projectUUID, observed.projectUUID); assert.equal(registered.generation, observed.generation);
  assert.equal(registered.runtimeVerified, false);
});

test('node rejects missing credentials, wrong machine and host path injection', async t => {
  const p = await projectFixture(t);
  const origin = await serve(t, assembleProjectInspection({machineId: 'node-1', credential, root: p.root, basePath: p.basePath, python, reportError() {}}));
  const post = (body, token) => fetch(origin + PROJECT_INSPECTION_ROUTE, {method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }, body: JSON.stringify(body)});
  const input = {...p.request, accountId: 'alice'};
  assert.equal((await post(input)).status, 401);
  assert.equal((await post({...input, machineId: 'other'}, credential)).status, 409);
  assert.equal((await post({...input, hostPath: '/private'}, credential)).status, 400);
});

test('wrong-account or wrong-release responses cannot become a registered project observation', async t => {
  const p = await projectFixture(t), result = await p.reader.inspect(p.request, context);
  for (const bad of [{...result, accountId: 'bob'}, {...result, release: 'a'.repeat(64)}]) {
    let calls = 0;
    const origin = await serve(t, (req, res) => {calls++; res.end(JSON.stringify({result: bad}));});
    const projects = new HttpProjectReader({nodes: [{machineId: 'node-1', origin, credential}]});
    await assert.rejects(projects.inspect(p.request, context), hasCode('PROJECT_NODE_UNAVAILABLE'));
    assert.equal(calls, 1);
  }
});

test('shared node transport never forwards credentials to a different origin or non-internal route', async () => {
  let calls = 0;
  const transport = new NodeJsonTransport({nodes: [{machineId: 'node-1', origin: 'https://node.example', credential}],
    fetch: async () => {calls++; throw new Error('must not call');}});
  for (const route of ['https://other.example/internal/v2/project/inspect', 'https://user:password@node.example/internal/v2/project/inspect', '/public', '/internal/v2/project/inspect?redirect=1']) {
    await assert.rejects(transport.request('node-1', route, {}), hasCode('NODE_UNAVAILABLE'));
  }
  assert.equal(calls, 0);
  assert.throws(() => new NodeJsonTransport({nodes: [{machineId: 'node-1', origin: 'https://node.example', credential: [credential]}]}), /Invalid/);
});
