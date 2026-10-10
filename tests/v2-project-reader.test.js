import test from 'node:test';
import assert from 'node:assert/strict';
import {rename, stat} from 'node:fs/promises';
import {projectFixture as fixture} from './helpers/v2-project-fixture.mjs';
import {parseProjectObservation} from '../src/contracts/project-inspection.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';
import {createProjectRegistrationSchema, SqliteProjectRegistrations} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';

const context = {actor: {id: 'alice'}};
const hasCode = code => error => error.code === code;

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
