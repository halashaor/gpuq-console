import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {publishedFixture} from './helpers/v2-published-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {ImportDataAccess} from '../src/application/import-data-access.mjs';
import {SqliteDataAccessImports, createDataAccessImportSchema} from '../src/infrastructure/sqlite/data-access-imports.mjs';
import {createManagedRegistrationSchema} from '../src/infrastructure/sqlite/managed-registrations.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  const publication = await publishedFixture(t, {owners: ['alice', 'old-bob']});
  createManagedRegistrationSchema(f.database); createDataAccessImportSchema(f.database);
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob')");
  f.database.prepare("INSERT INTO v2_data_resources(id,kind,source_id,version,visibility,owner_id) VALUES('published','dataset','images',?,'private','alice')").run(publication.version);
  for (const kind of ['cache', 'warehouse']) f.database.prepare('INSERT INTO v2_managed_bindings VALUES(?,?,?)').run('published', 'node-1', kind);
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
  await new SessionClient({transport, delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare("SELECT id FROM v2_sessions WHERE account_id='alice'").get().id};
  let calls = 0;
  const legacyAccess = {exportAccess(request) {calls++; return publication.managed.exportAccess(request, {actor: {id: 'alice'}});}};
  const imports = new SqliteDataAccessImports({database: f.database});
  const app = new ImportDataAccess({imports, legacyAccess, accountMapping: [{legacyId: 'alice', accountId: 'alice'}, {legacyId: 'old-bob', accountId: 'bob'}]});
  const plan = await app.plan(actor, {resourceId: 'published'});
  assert.equal(plan.state, 'proposed');
  const command = {resourceId: 'published', requestId: randomUUID(), planId: plan.planId};
  return {...f, ...publication, actor, legacyAccess, imports, app, plan, command, calls: () => calls,
    readers: () => f.database.prepare("SELECT account_id FROM v2_data_readers WHERE resource_id='published' ORDER BY account_id").all().map(row => row.account_id)};
}

test('import re-observes real legacy ACLs and atomically records readers with a durable receipt, without activation', async t => {
  const f = await fixture(t);
  const files = ['cache', 'warehouse'].map(kind => join(f.directory, kind, '.registry', 'images', 'dataset.json'));
  const before = await Promise.all(files.map(file => readFile(file)));
  const calls = f.calls();
  const result = await f.app.apply(f.actor, f.command);
  assert.deepEqual(result, {requestId: f.command.requestId, resourceId: 'published', state: 'imported', aclRevision: 1});
  assert.deepEqual(f.readers(), ['bob']);
  assert.equal(f.calls(), calls + 2);
  assert.deepEqual(await f.app.receipt(f.actor, f.command), result);
  assert.deepEqual(await f.app.receipt(f.actor, {requestId: f.command.requestId}), result, 'receipt lookup needs only the original request ID');
  const reopened = new DatabaseSync(f.database.prepare('PRAGMA database_list').get().file, {readOnly: true});
  try {
    assert.deepEqual(new SqliteDataAccessImports({database: reopened}).receipt(f.actor, f.command, Date.now()), result);
  } finally {reopened.close();}
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  await assert.rejects(f.managed.inspect(f.request('warehouse'), {actor: {id: 'bob'}}), hasCode('FORBIDDEN'));
  assert.equal(f.database.prepare("SELECT count(*) n FROM v2_machine_grants WHERE account_id='bob'").get().n, 0);
});

test('source ACL changes after planning invalidate import instead of using old readers', async t => {
  const f = await fixture(t);
  for (const kind of ['cache', 'warehouse']) {
    const file = join(f.directory, kind, '.registry', 'images', 'dataset.json');
    const value = JSON.parse(await readFile(file, 'utf8')); value.owners = ['alice'];
    await writeFile(file, JSON.stringify(value));
  }
  await assert.rejects(f.app.apply(f.actor, f.command), hasCode('IMPORT_PLAN_CHANGED'));
  assert.deepEqual(f.readers(), []);
  assert.equal(await f.app.receipt(f.actor, f.command), null);
});

test('concurrent V2 ACL change or missing mapped account prevents import', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_data_resources SET acl_revision=1 WHERE id='published'");
  await assert.rejects(f.app.apply(f.actor, f.command), hasCode('IMPORT_PLAN_CHANGED'));
  f.database.exec("UPDATE v2_data_resources SET acl_revision=0 WHERE id='published'; DELETE FROM v2_accounts WHERE id='bob'");
  await assert.rejects(f.app.apply(f.actor, f.command), hasCode('IMPORT_PLAN_CHANGED'));
  assert.deepEqual(f.readers(), []);
});

test('receipt storage failure rolls back the complete ACL change', async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER fail_import BEFORE INSERT ON v2_data_access_imports BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  await assert.rejects(f.app.apply(f.actor, f.command), /injected receipt failure/);
  assert.deepEqual(f.readers(), []);
  assert.equal(f.database.prepare("SELECT acl_revision FROM v2_data_resources WHERE id='published'").get().acl_revision, 0);
  assert.equal(await f.app.receipt(f.actor, f.command), null);
  f.database.exec('DROP TRIGGER fail_import');
  assert.equal((await f.app.apply(f.actor, f.command)).aclRevision, 1);
});

test('same request racing or recovering a lost response returns one historical receipt without reapplying', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.app.apply(f.actor, f.command), f.app.apply(f.actor, f.command)]);
  assert.deepEqual(a, b);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_access_imports').get().n, 1);
  f.legacyAccess.exportAccess = () => {throw new Error('recovery must not query or reapply');};
  f.database.exec("DELETE FROM v2_data_readers WHERE resource_id='published'; UPDATE v2_data_resources SET acl_revision=2 WHERE id='published'");
  assert.deepEqual(await f.app.apply(f.actor, f.command), a);
  assert.deepEqual(f.readers(), []);
  await assert.rejects(f.app.apply(f.actor, {...f.command, planId: 'd'.repeat(64)}), hasCode('IMPORT_REQUEST_CONFLICT'));
});

test('administrator revocation during observation blocks both import and receipt access', async t => {
  const f = await fixture(t), original = f.legacyAccess.exportAccess;
  const before = f.calls();
  f.legacyAccess.exportAccess = async request => {
    const result = await original(request);
    f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
    return result;
  };
  await assert.rejects(f.app.apply(f.actor, f.command), hasCode('UNAUTHENTICATED'));
  assert.equal(f.calls(), before + 1, 'revocation stops the next source query');
  await assert.rejects(f.app.receipt(f.actor, f.command), hasCode('UNAUTHENTICATED'));
  assert.deepEqual(f.readers(), []);
});

test('another administrator cannot reuse the original caller request identity', async t => {
  const f = await fixture(t);
  await f.app.apply(f.actor, f.command);
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name,role) VALUES('charlie','charlie','Charlie','admin');
    INSERT INTO v2_credentials SELECT 'charlie',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
  await new SessionClient({transport, delivery: 'token'}).login({...loginRequest, username: 'charlie'});
  const actor = {id: 'charlie', sessionId: f.database.prepare("SELECT id FROM v2_sessions WHERE account_id='charlie'").get().id};
  await assert.rejects(f.app.receipt(actor, f.command), hasCode('IMPORT_REQUEST_CONFLICT'));
  await assert.rejects(f.app.apply(actor, f.command), hasCode('IMPORT_REQUEST_CONFLICT'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_access_imports').get().n, 1);
});
