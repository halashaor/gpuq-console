import test from 'node:test';
import assert from 'node:assert/strict';
import {stat, readdir, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DirectoryClient} from '../src/client/directory-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {RegisterDirectory} from '../src/application/register-directory.mjs';
import {SqliteDirectoryRegistrations} from '../src/infrastructure/sqlite/directory-registrations.mjs';
import {ConfiguredDirectories} from '../src/infrastructure/configured-directories.mjs';
import {parseDirectoryRegistration} from '../src/contracts/directory-registration.mjs';

const hasCode = code => error => error.code === code;
const request = {machineId: 'node-1', sourceId: 'existing'};
async function fixture(t) {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
  await new SessionClient({transport, delivery: 'token'}).login(loginRequest);
  const source = f.database.prepare('SELECT host_path FROM v2_source_bindings').get().host_path;
  return {...f, source, transport, directories: new DirectoryClient({transport}), data: new DataClient({transport})};
}

test('registration records the existing directory without copying, scanning or marking a managed version ready', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'sample'), 'original');
  const inode = (await stat(f.source)).ino, entries = await readdir(f.source);
  const result = await f.directories.register(request);
  assert.deepEqual(Object.keys(result).sort(), ['machineId', 'registered', 'resourceId', 'sourceId']);
  assert.equal(result.registered, true);
  assert.equal(JSON.stringify(result).includes(f.source), false);
  const binding = f.database.prepare('SELECT host_path,ready FROM v2_source_bindings WHERE resource_id=?').get(result.resourceId);
  assert.equal(binding.host_path, f.source);
  assert.equal(binding.ready, 0);
  const read = await f.data.resolveReadLocation({machineId: request.machineId, source: {kind: 'directory', sourceId: request.sourceId}});
  assert.equal(read.location.containerPath, '/datasets/existing');
  assert.equal((await stat(f.source)).ino, inode);
  assert.deepEqual(await readdir(f.source), entries);
  assert.equal(await readFile(join(f.source, 'sample'), 'utf8'), 'original');
});

test('metadata registration is not a filesystem availability or container mount proof', async t => {
  const f = await fixture(t);
  assert.equal((await f.directories.register({...request, sourceId: 'missing'})).registered, true);
  assert.equal((await f.data.resolveReadLocation({machineId: 'node-1', source: {kind: 'directory', sourceId: 'missing'}})).availability, 'missing');
});

test('concurrent identical registration returns one identity and never replaces existing permissions', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.directories.register(request), f.directories.register(request)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_data_resources WHERE source_id='existing'").get().n, 1);
  f.database.prepare('UPDATE v2_data_resources SET acl_revision=7 WHERE id=?').run(results[0].resourceId);
  await f.directories.register(request);
  assert.equal(f.database.prepare('SELECT acl_revision FROM v2_data_resources WHERE id=?').get(results[0].resourceId).acl_revision, 7);
});

test('configuration conflicts cannot silently rebind an already registered source', async t => {
  const f = await fixture(t);
  const registered = await f.directories.register(request);
  f.database.prepare('UPDATE v2_source_bindings SET host_path=? WHERE resource_id=?').run('/different/configured/path', registered.resourceId);
  await assert.rejects(f.directories.register(request), hasCode('SOURCE_REGISTRATION_CONFLICT'));
  assert.equal(f.database.prepare('SELECT host_path FROM v2_source_bindings WHERE resource_id=?').get(registered.resourceId).host_path, '/different/configured/path');
});

test('unknown source/machine and caller-supplied path are rejected without phantom registrations', async t => {
  const f = await fixture(t);
  await assert.rejects(f.directories.register({...request, sourceId: 'unknown'}), hasCode('SOURCE_NOT_CONFIGURED'));
  await assert.rejects(f.directories.register({...request, machineId: 'unlisted'}), hasCode('MACHINE_NOT_FOUND'));
  assert.throws(() => parseDirectoryRegistration({...request, hostPath: '/some/path'}), hasCode('INVALID_REQUEST'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_resources').get().n, 1);
});

test('authorization precedes configuration access and is checked again before commit', async t => {
  const f = await fixture(t);
  const registrations = new SqliteDirectoryRegistrations({database: f.database});
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id};
  let lookups = 0;
  const register = new RegisterDirectory({registrations, configuredSources: {find: async () => {
    lookups++; f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
    return {hostPath: f.source, visibility: 'shared', ownerId: null};
  }}});
  await assert.rejects(register.execute({...actor, id: 'wrong'}, request), hasCode('UNAUTHENTICATED'));
  assert.equal(lookups, 0);
  await assert.rejects(register.execute(actor, request), hasCode('UNAUTHENTICATED'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_resources').get().n, 1);
});

test('binding insertion failure rolls back resource creation', async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON v2_source_bindings BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(f.directories.register(request), hasCode('INTERNAL_ERROR'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_resources').get().n, 1);
});

test('operator configuration is copied and rejects duplicate names or relative host paths', () => {
  const entry = {...request, hostPath: '/data/existing', visibility: 'shared', ownerId: null};
  const config = new ConfiguredDirectories([entry]);
  entry.hostPath = '/changed';
  const found = config.find(request); found.hostPath = '/changed-again';
  assert.equal(config.find(request).hostPath, '/data/existing');
  assert.throws(() => new ConfiguredDirectories([entry, entry]), /Duplicate/);
  assert.throws(() => new ConfiguredDirectories([{...entry, hostPath: 'relative'}]), /Invalid/);
});
