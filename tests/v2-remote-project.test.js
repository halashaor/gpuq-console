import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {projectFixture, python} from './helpers/v2-project-fixture.mjs';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {assembleProjectInspection} from '../src/bootstrap/project-inspection.mjs';
import {HttpProjectReader} from '../src/infrastructure/http-project-reader.mjs';
import {NodeJsonTransport} from '../src/infrastructure/node-json-transport.mjs';
import {PROJECT_INSPECTION_ROUTE, PROJECT_RUNTIME_ROUTE, parseProjectRuntimeObservation} from '../src/contracts/project-inspection.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';
import {createTrainingCatalogSchema, SqliteTrainingCatalog} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {ObserveTrainingCandidates} from '../src/application/observe-training-candidates.mjs';
import {createProjectRegistrationSchema, SqliteProjectRegistrations} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {ResolveTrainingData} from '../src/application/resolve-training-data.mjs';
import {DataReadAccess} from '../src/application/data-read-access.mjs';
import {SqliteDataAuthority, SqliteSourceCatalog} from '../src/infrastructure/sqlite/data-read-repositories.mjs';
import {LocalSourceReader} from '../src/infrastructure/local-source-reader.mjs';

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
  f.database.exec("UPDATE v2_machines SET cards=8; UPDATE v2_machine_grants SET max_cards=2; INSERT INTO v2_compute_policies VALUES('alice',2,0)");
  const data = new ResolveTrainingData({access: new DataReadAccess({authority: new SqliteDataAuthority({database: f.database})}),
    sources: new LocalSourceReader({machineId: 'node-1', catalog: new SqliteSourceCatalog({database: f.database})})});
  const observer = new ObserveTrainingCandidates({catalog: new SqliteTrainingCatalog({database: f.database}), projects, data});
  const request = {project: {id: 'logical', release: p.release}, machines: {kind: 'any'}, resources: {minGpus: 1}, dataSources: [{kind: 'directory', sourceId: 'images'}]};
  const candidates = await observer.execute(actor, request);
  assert.equal(candidates.candidates.length, 1);
  assert.equal(candidates.candidates[0].generation, observed.generation);
  assert.equal(candidates.candidates[0].runtimeIdentityVerified, true);
  assert.equal(candidates.candidates[0].runtime.kind, 'base');
  assert.deepEqual(candidates.candidates[0].dataReads[0].location, {containerPath: '/datasets/images', readOnly: true});
  await rename(p.basePath, p.basePath + '-offline');
  const unavailable = await observer.execute(actor, request);
  assert.deepEqual(unavailable.candidates, []);
  assert.deepEqual(unavailable.excluded, [{machineId: 'node-1', reason: 'runtime-unavailable'}]);
  await assert.rejects(stat(p.basePath), {code: 'ENOENT'});
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

test('runtime identity uses the real node/native chain without executing the synthetic interpreter', async t => {
  const p = await projectFixture(t);
  const origin = await serve(t, assembleProjectInspection({machineId: 'node-1', credential, root: p.root, basePath: p.basePath, python, reportError() {}}));
  const projects = new HttpProjectReader({nodes: [{machineId: 'node-1', origin, credential}]});
  const metadata = await projects.inspect(p.request, context);
  const runtime = await projects.verifyRuntime(p.request, context);
  assert.deepEqual(runtime, await p.reader.verifyRuntime(p.request, context));
  assert.equal(runtime.projectUUID, metadata.projectUUID);
  assert.equal(runtime.generation, metadata.generation);
  assert.equal(runtime.runtimeIdentityVerified, true);
  assert.equal(Object.hasOwn(runtime, 'runtimeVerified'), false);
  assert.equal(runtime.runtime.kind, 'base');
  assert.match(runtime.runtime.identity, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(runtime).includes(p.root), false);
  await assert.rejects(projects.verifyRuntime(p.request, {actor: {id: 'bob'}}), hasCode('PROJECT_NODE_UNAVAILABLE'));
  await rename(p.basePath, p.basePath + '-offline');
  await assert.rejects(projects.verifyRuntime(p.request, context), hasCode('PROJECT_NODE_UNAVAILABLE'));
  assert.equal((await projects.inspect(p.request, context)).runtimeVerified, false);
  await assert.rejects(stat(p.basePath), {code: 'ENOENT'});
  await rename(p.basePath + '-offline', p.basePath);
  assert.deepEqual(await projects.verifyRuntime(p.request, context), runtime);
  await writeFile(join(p.basePath, 'bin/python3.12'), 'changed fixture interpreter');
  await assert.rejects(projects.verifyRuntime(p.request, context), hasCode('PROJECT_NODE_UNAVAILABLE'));
});

test('runtime route shares node authentication and never accepts caller-supplied runtime configuration', async t => {
  const p = await projectFixture(t);
  const origin = await serve(t, assembleProjectInspection({machineId: 'node-1', credential, root: p.root, basePath: p.basePath, python, reportError() {}}));
  const post = (body, token) => fetch(origin + PROJECT_RUNTIME_ROUTE, {method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }, body: JSON.stringify(body)});
  const input = {...p.request, accountId: 'alice'};
  assert.equal((await post(input)).status, 401);
  assert.equal((await post({...input, machineId: 'other'}, credential)).status, 409);
  assert.equal((await post({...input, runtimeConfig: {root: '/private'}}, credential)).status, 400);
});

test('runtime replies reject metadata-only success, changed identity and inconsistent image claims', async t => {
  const p = await projectFixture(t), result = await p.reader.verifyRuntime(p.request, context);
  const metadata = await p.reader.inspect(p.request, context);
  for (const bad of [metadata, {...result, runtimeIdentityVerified: false}, {...result, lifecycle: 'ARCHIVED'},
    {...result, runtime: {kind: 'oci', identity: 'sha256:' + 'a'.repeat(64)}}, {...result, runtime: {...result.runtime, hostPath: '/private'}}]) {
    assert.throws(() => parseProjectRuntimeObservation(bad), hasCode('INVALID_API_RESPONSE'));
  }
  const oci = {...result, environmentMode: 'oci', runtime: {kind: 'oci', identity: 'sha256:' + 'a'.repeat(64)}};
  assert.deepEqual(parseProjectRuntimeObservation(oci), oci);
  for (const bad of [metadata, {...result, accountId: 'bob'}, {...result, machineId: 'other'}, {...result, release: 'a'.repeat(64)}]) {
    const origin = await serve(t, (req, res) => res.end(JSON.stringify({result: bad})));
    const projects = new HttpProjectReader({nodes: [{machineId: 'node-1', origin, credential}]});
    await assert.rejects(projects.verifyRuntime(p.request, context), hasCode('PROJECT_NODE_UNAVAILABLE'));
  }
});
