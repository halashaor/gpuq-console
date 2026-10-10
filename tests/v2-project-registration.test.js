import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {createTrainingCatalogSchema, SqliteTrainingCatalog} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema, SqliteProjectRegistrations} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {RegisterProjectRelease} from '../src/application/register-project-release.mjs';

const request = {projectId: 'logical-project', machineId: 'node-1', project: 'training', release: 'a'.repeat(64)};
const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id};
  let calls = 0;
  const observed = {accountId: 'alice', machineId: 'node-1', project: request.project, release: request.release, projectUUID: randomUUID(), generation: 'b'.repeat(64),
    environmentMode: 'oci', lifecycle: 'ACTIVE', runtimeVerified: false};
  const projects = {async inspect(input, context) {calls++; assert.equal(context.actor.id, 'alice'); return {...observed, project: input.project, release: input.release};}};
  const registrations = new SqliteProjectRegistrations({database: f.database});
  const app = new RegisterProjectRelease({registrations, projects});
  return {...f, actor, observed, projects, app, calls: () => calls};
}

test('one transaction registers owner, fixed release and exact instance without claiming runtime readiness', async t => {
  const f = await fixture(t), result = await f.app.execute(f.actor, request);
  assert.equal(result.projectUUID, f.observed.projectUUID); assert.equal(result.runtimeVerified, false);
  assert.deepEqual(await f.app.execute(f.actor, request), result);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_projects').get().n, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_release_locations').get().n, 1);
  f.database.exec("UPDATE v2_machines SET cards=8; UPDATE v2_machine_grants SET max_cards=4; INSERT INTO v2_compute_policies VALUES('alice',4,0)");
  const candidates = new SqliteTrainingCatalog({database: f.database}).candidates(f.actor,
    {project: {id: request.projectId, release: request.release}, machines: {kind: 'any'}, resources: {minGpus: 1}}, Date.now());
  assert.deepEqual(candidates.candidates, [{machineId: 'node-1', maxConfiguredGpus: 4}]);
});

test('new release keeps instance identity; same-name replacement or alias does not silently rebind', async t => {
  const f = await fixture(t); await f.app.execute(f.actor, request);
  await f.app.execute(f.actor, {...request, release: 'c'.repeat(64)});
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_project_releases').get().n, 2);
  await assert.rejects(f.app.execute(f.actor, {...request, projectId: 'alias'}), hasCode('PROJECT_INSTANCE_CONFLICT'));
  f.observed.generation = 'd'.repeat(64);
  await assert.rejects(f.app.execute(f.actor, request), hasCode('PROJECT_INSTANCE_CONFLICT'));
  assert.equal(f.database.prepare('SELECT generation FROM v2_project_instances').get().generation, 'b'.repeat(64));
});

test('machine denial happens before observation and revocation during observation prevents writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.app.execute(f.actor, {...request, machineId: 'unknown'}), hasCode('FORBIDDEN'));
  assert.equal(f.calls(), 0);
  const original = f.projects.inspect;
  f.projects.inspect = async (...args) => {const result = await original(...args); f.database.exec('DELETE FROM v2_machine_grants'); return result;};
  await assert.rejects(f.app.execute(f.actor, request), hasCode('FORBIDDEN'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_projects').get().n, 0);
});

test('inactive or misbound node observations cannot register a release', async t => {
  const f = await fixture(t);
  f.observed.lifecycle = 'ARCHIVED';
  await assert.rejects(f.app.execute(f.actor, request), hasCode('PROJECT_NOT_ACTIVE'));
  f.projects.inspect = async () => ({...f.observed, lifecycle: 'ACTIVE', release: 'f'.repeat(64)});
  await assert.rejects(f.app.execute(f.actor, request), hasCode('PROJECT_OBSERVATION_INVALID'));
  f.projects.inspect = async () => ({...f.observed, lifecycle: 'ACTIVE', machineId: 'other-node'});
  await assert.rejects(f.app.execute(f.actor, request), hasCode('PROJECT_OBSERVATION_INVALID'));
  f.projects.inspect = async () => ({...f.observed, lifecycle: 'ACTIVE', accountId: 'other-account'});
  await assert.rejects(f.app.execute(f.actor, request), hasCode('PROJECT_OBSERVATION_INVALID'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_projects').get().n, 0);
});

test('another account project and archived catalogue entries are denied before node observation', async t => {
  const f = await fixture(t);
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob'); INSERT INTO v2_projects(id,owner_id) VALUES('logical-project','bob')");
  await assert.rejects(f.app.execute(f.actor, request), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_projects SET owner_id='alice',archived=1");
  await assert.rejects(f.app.execute(f.actor, request), hasCode('PROJECT_ARCHIVED'));
  assert.equal(f.calls(), 0);
});

test('concurrent identical registration returns one binding', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.app.execute(f.actor, request), f.app.execute(f.actor, request)]);
  assert.deepEqual(first, second);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_project_instances').get().n, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_release_locations').get().n, 1);
});

test('release location failure rolls back every new catalogue record', async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER reject_location BEFORE INSERT ON v2_release_locations BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(f.app.execute(f.actor, request), /injected failure/);
  for (const table of ['v2_projects','v2_project_instances','v2_project_releases','v2_release_locations']) {
    assert.equal(f.database.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});
