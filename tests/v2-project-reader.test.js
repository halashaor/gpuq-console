import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdtemp, readdir, chmod, rm, rename, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectMetadataReader} from '../src/infrastructure/project-metadata-reader.mjs';
import {parseProjectObservation} from '../src/contracts/project-inspection.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';
import {createProjectRegistrationSchema, SqliteProjectRegistrations} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';

const run = promisify(execFile), python = process.env.V2_PYTHON || 'python3', context = {actor: {id: 'alice'}};
const hasCode = code => error => error.code === code;
async function writableDirectories(path) {
  await chmod(path, 0o700);
  for (const item of await readdir(path, {withFileTypes: true})) {
    if (item.isDirectory()) await writableDirectories(join(path, item.name));
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'v2-project-'));
  t.after(async () => {await writableDirectories(directory); await rm(directory, {recursive: true, force: true});});
  const {stdout} = await run(python, ['-B', fileURLToPath(new URL('./helpers/v2-project-fixture.py', import.meta.url)), directory]);
  const config = JSON.parse(stdout);
  return {...config, directory, request: {machineId: 'node-1', project: 'training', release: config.release},
    reader: new ProjectMetadataReader({machineId: 'node-1', ...config, python})};
}

test('real native project observation binds account, node, persistent UUID and generation without claiming runtime readiness', async t => {
  const f = await fixture(t);
  const observation = await f.reader.inspect(f.request, context);
  assert.equal(observation.accountId, 'alice'); assert.equal(observation.machineId, 'node-1');
  assert.equal(observation.release, f.release); assert.equal(observation.runtimeVerified, false);
  assert.match(observation.projectUUID, /^[a-f0-9-]{36}$/); assert.match(observation.generation, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(observation).includes(f.root), false);
  assert.deepEqual(await f.reader.inspect(f.request, context), observation);
  await assert.rejects(f.reader.inspect(f.request, {actor: {id: 'bob'}}), hasCode('PROJECT_SOURCE_UNAVAILABLE'));
});

test('metadata inspection remains possible when the runtime base is absent, without creating or restoring it', async t => {
  const f = await fixture(t);
  await rename(f.basePath, f.basePath + '-offline');
  assert.equal((await f.reader.inspect(f.request, context)).runtimeVerified, false);
  await assert.rejects(stat(f.basePath), {code: 'ENOENT'});
});

test('wrong node, caller identity override and malformed runtime claims are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.reader.inspect({...f.request, machineId: 'other'}, context), hasCode('PROJECT_NODE_MISMATCH'));
  await assert.rejects(f.reader.inspect({...f.request, accountId: 'bob'}, context), hasCode('INVALID_REQUEST'));
  const valid = await f.reader.inspect(f.request, context);
  assert.throws(() => parseProjectObservation({...valid, runtimeVerified: true}), hasCode('INVALID_API_RESPONSE'));
  assert.throws(() => parseProjectObservation({...valid, hostPath: '/private'}), hasCode('INVALID_API_RESPONSE'));
});

test('registration consumes the real native observation and persists exactly that instance', async t => {
  const p = await fixture(t), f = await sessionFixture(); t.after(() => f.close());
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id};
  const app = new RegisterProjectRelease({registrations: new SqliteProjectRegistrations({database: f.database}), projects: p.reader});
  const result = await app.execute(actor, {...p.request, projectId: 'logical-project'});
  const observed = await p.reader.inspect(p.request, {actor});
  assert.equal(result.projectUUID, observed.projectUUID); assert.equal(result.generation, observed.generation);
  assert.equal(result.runtimeVerified, false);
  const row = f.database.prepare('SELECT * FROM v2_project_instances').get();
  assert.equal(row.project_uuid, observed.projectUUID); assert.equal(row.generation, observed.generation);
});
