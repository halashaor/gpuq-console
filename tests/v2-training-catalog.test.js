import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SqliteTrainingCatalog, createTrainingCatalogSchema} from '../src/infrastructure/sqlite/training-catalog.mjs';

const release = 'a'.repeat(64);
const request = {project: {id: 'project-1', release}, machines: {kind: 'any'}, resources: {minGpus: 2}};
const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  createTrainingCatalogSchema(f.database);
  f.database.exec(`UPDATE v2_machines SET cards=8 WHERE id='node-1';
    UPDATE v2_machine_grants SET max_cards=4 WHERE account_id='alice';
    INSERT INTO v2_compute_policies VALUES('alice',3,0);
    INSERT INTO v2_projects(id,owner_id) VALUES('project-1','alice');
    INSERT INTO v2_machines(id,cards) VALUES('node-2',6),('private-node',8);
    INSERT INTO v2_machine_grants(account_id,machine_id,max_cards) VALUES('alice','node-2',2)`);
  f.database.prepare('INSERT INTO v2_project_releases VALUES(?,?)').run('project-1', release);
  for (const machine of ['node-1','node-2','private-node']) f.database.prepare('INSERT INTO v2_release_locations VALUES(?,?,?)').run('project-1', release, machine);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id};
  return {...f, actor, catalog: new SqliteTrainingCatalog({database: f.database}), now: Date.now()};
}

test('catalogue candidates require project ownership, exact release and machine grants without writes', async t => {
  const f = await fixture(t), before = f.database.prepare('SELECT total_changes() n').get().n;
  const result = f.catalog.candidates(f.actor, request, f.now);
  assert.deepEqual(result.candidates, [{machineId: 'node-1', maxConfiguredGpus: 3}, {machineId: 'node-2', maxConfiguredGpus: 2}]);
  assert.deepEqual(result.excluded, []);
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(JSON.stringify(result).includes('private-node'), false);
});

test('explicit machine selection preserves order and does not broaden the requested set', async t => {
  const f = await fixture(t);
  const result = f.catalog.candidates(f.actor, {...request, machines: {kind: 'selected', ids: ['node-2','unknown','node-1']}}, f.now);
  assert.deepEqual(result.candidates.map(row => row.machineId), ['node-2','node-1']);
  assert.deepEqual(result.excluded, [{machineId: 'unknown', reason: 'not-authorized'}]);
});

test('one disabled or absent-release machine does not block other authorized candidates', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_machines SET enabled=0 WHERE id='node-1'");
  assert.deepEqual(f.catalog.candidates(f.actor, request, f.now).candidates.map(row => row.machineId), ['node-2']);
  f.database.exec("UPDATE v2_machines SET enabled=1 WHERE id='node-1'; DELETE FROM v2_release_locations WHERE machine_id='node-1'");
  assert.equal(f.catalog.candidates(f.actor, request, f.now).excluded[0].reason, 'release-not-registered');
});

test('unknown quota/capacity is not zero or permission, and configured limits are not idle GPU counts', async t => {
  const f = await fixture(t);
  const tooLarge = f.catalog.candidates(f.actor, {...request, resources: {minGpus: 4}}, f.now);
  assert.deepEqual(tooLarge.candidates, []);
  assert.ok(tooLarge.excluded.every(row => row.reason === 'configured-limit-too-small'));
  f.database.exec("UPDATE v2_machine_grants SET max_cards=NULL WHERE machine_id='node-1'; UPDATE v2_machines SET cards=NULL WHERE id='node-2'");
  const result = f.catalog.candidates(f.actor, request, f.now);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.excluded.map(row => row.reason), ['quota-uninitialized','capacity-unknown']);
});

test('archived projects, unknown releases and changed account authorization prevent eligibility', async t => {
  const f = await fixture(t);
  f.database.exec('UPDATE v2_projects SET archived=1');
  assert.throws(() => f.catalog.candidates(f.actor, request, f.now), hasCode('PROJECT_ARCHIVED'));
  f.database.exec('UPDATE v2_projects SET archived=0');
  assert.throws(() => f.catalog.candidates(f.actor, {...request, project: {...request.project, release: 'b'.repeat(64)}}, f.now), hasCode('PROJECT_RELEASE_NOT_FOUND'));
  f.database.exec('UPDATE v2_accounts SET auth_revision=1');
  assert.throws(() => f.catalog.candidates(f.actor, request, f.now), hasCode('UNAUTHENTICATED'));
});

test('administrators inherit enabled machine access but cannot train from another account private project', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_accounts SET role='admin' WHERE id='alice'");
  assert.equal(f.catalog.candidates(f.actor, request, f.now).candidates.length, 3);
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob'); UPDATE v2_projects SET owner_id='bob'");
  assert.throws(() => f.catalog.candidates(f.actor, request, f.now), hasCode('FORBIDDEN'));
});
