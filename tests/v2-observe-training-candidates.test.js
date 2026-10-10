import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {createTrainingCatalogSchema, SqliteTrainingCatalog} from '../src/infrastructure/sqlite/training-catalog.mjs';
import {createProjectRegistrationSchema} from '../src/infrastructure/sqlite/project-registrations.mjs';
import {ObserveTrainingCandidates} from '../src/application/observe-training-candidates.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';

const release = 'a'.repeat(64), request = {project: {id: 'logical', release}, machines: {kind: 'any'}, resources: {minGpus: 1}};
const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  createTrainingCatalogSchema(f.database); createProjectRegistrationSchema(f.database);
  f.database.exec(`UPDATE v2_machines SET cards=8; UPDATE v2_machine_grants SET max_cards=4;
    INSERT INTO v2_machines(id,cards) VALUES('node-2',4);
    INSERT INTO v2_machine_grants VALUES('alice','node-2',4);
    INSERT INTO v2_compute_policies VALUES('alice',4,0);
    INSERT INTO v2_projects(id,owner_id) VALUES('logical','alice')`);
  f.database.prepare('INSERT INTO v2_project_releases VALUES(?,?)').run('logical', release);
  const observations = new Map();
  for (const machineId of ['node-1','node-2']) {
    const uuid = randomUUID(), generation = 'b'.repeat(64);
    f.database.prepare('INSERT INTO v2_project_instances VALUES(?,?,?,?,?)').run('logical', machineId, 'training', uuid, generation);
    f.database.prepare('INSERT INTO v2_release_locations VALUES(?,?,?)').run('logical', release, machineId);
    observations.set(machineId, {accountId: 'alice', machineId, project: 'training', release, projectUUID: uuid,
      generation, environmentMode: 'oci', lifecycle: 'ACTIVE', runtimeVerified: false});
  }
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id}, calls = [];
  const projects = {async inspect(reference) {calls.push(reference.machineId); return {...observations.get(reference.machineId)};}};
  const app = new ObserveTrainingCandidates({catalog: new SqliteTrainingCatalog({database: f.database}), projects});
  return {...f, actor, observations, calls, projects, app};
}

test('only exact registered active instances survive observation, without claiming runtime/GPU readiness', async t => {
  const f = await fixture(t), writes = f.database.prepare('SELECT total_changes() n').get().n;
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-1','node-2']);
  assert.ok(result.candidates.every(row => row.runtimeVerified === false && row.maxConfiguredGpus === 4));
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, writes);
});

test('one unavailable node does not block another healthy project instance', async t => {
  const f = await fixture(t), original = f.projects.inspect;
  f.projects.inspect = async reference => {if (reference.machineId === 'node-1') throw new ApplicationError('PROJECT_NODE_UNAVAILABLE'); return original(reference);};
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-2']);
  assert.deepEqual(result.excluded, [{machineId: 'node-1', reason: 'node-unavailable'}]);
});

test('changed generation and archived metadata are excluded rather than silently adopted', async t => {
  const f = await fixture(t);
  f.observations.get('node-1').generation = 'c'.repeat(64);
  f.observations.get('node-2').lifecycle = 'ARCHIVED';
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.excluded.map(row => row.reason), ['instance-changed','project-inactive']);
});

test('permissions changing during a node query invalidate the whole result and stop subsequent queries', async t => {
  const f = await fixture(t), original = f.projects.inspect;
  f.projects.inspect = async reference => {const value = await original(reference); f.database.exec("DELETE FROM v2_machine_grants WHERE machine_id='node-2'"); return value;};
  await assert.rejects(f.app.execute(f.actor, request), hasCode('TRAINING_CONTEXT_CHANGED'));
  assert.deepEqual(f.calls, ['node-1']);
});

test('revocation masks a simultaneous node error and prevents stale eligibility', async t => {
  const f = await fixture(t);
  f.projects.inspect = async () => {f.database.exec('UPDATE v2_accounts SET enabled=0'); throw new ApplicationError('PROJECT_NODE_UNAVAILABLE');};
  await assert.rejects(f.app.execute(f.actor, request), hasCode('UNAUTHENTICATED'));
});

test('metadata without an instance binding makes no node request and is never marked ready', async t => {
  const f = await fixture(t); f.database.exec('DELETE FROM v2_project_instances');
  const result = await f.app.execute(f.actor, request);
  assert.deepEqual(result.candidates, []); assert.deepEqual(f.calls, []);
  assert.ok(result.excluded.every(row => row.reason === 'instance-not-registered'));
});
