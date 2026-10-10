import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionFixture, loginRequest, readRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {DataAccessClient} from '../src/client/data-access-client.mjs';
import {parseDataReaders} from '../src/contracts/data-access.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice';
    INSERT INTO v2_machine_grants(account_id,machine_id,max_cards) VALUES('bob','node-1',1);
    UPDATE v2_data_resources SET visibility='private',owner_id='alice'`);
  async function client(username) {
    const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
    const session = new SessionClient({transport, delivery: 'token'});
    await session.login({...loginRequest, username});
    return {session, transport, data: new DataClient({transport}), access: new DataAccessClient({transport})};
  }
  return {...f, admin: await client('alice'), member: await client('bob')};
}
const change = (revision, readers) => ({resourceId: 'images', revision, readers});

test('data grant and revocation affect the existing reader session without copying or changing bindings', async t => {
  const f = await fixture(t);
  const before = f.database.prepare('SELECT * FROM v2_source_bindings').all();
  await assert.rejects(f.member.data.resolveReadLocation(readRequest), hasCode('FORBIDDEN'));
  assert.deepEqual(await f.admin.access.setReaders(change(0, ['bob'])), {...change(1, ['bob']), visibility: 'private', ownerId: 'alice'});
  assert.equal((await f.member.data.resolveReadLocation(readRequest)).availability, 'available');
  await f.admin.access.setReaders(change(1, []));
  await assert.rejects(f.member.data.resolveReadLocation(readRequest), hasCode('FORBIDDEN'));
  await f.member.session.refresh();
  assert.deepEqual(f.database.prepare('SELECT * FROM v2_source_bindings').all(), before);
});

test('members cannot self-grant; machine permission and shared visibility retain their independent meanings', async t => {
  const f = await fixture(t);
  await assert.rejects(f.member.access.setReaders(change(0, ['bob'])), hasCode('FORBIDDEN'));
  await f.admin.access.setReaders(change(0, ['bob']));
  f.database.exec("DELETE FROM v2_machine_grants WHERE account_id='bob'");
  await assert.rejects(f.member.data.resolveReadLocation(readRequest), hasCode('FORBIDDEN'));
  f.database.exec("UPDATE v2_data_resources SET visibility='shared'");
  await assert.rejects(f.admin.access.setReaders(change(1, [])), hasCode('DATA_SOURCE_SHARED'));
});

test('warehouse and cache are two bindings of the same fixed-version permission resource', async t => {
  const f = await fixture(t), version = 'a'.repeat(64);
  f.database.prepare(`INSERT INTO v2_data_resources(id,kind,source_id,version,visibility,owner_id)
    VALUES('dataset','dataset','training',?,'private','alice')`).run(version);
  const path = f.database.prepare('SELECT host_path FROM v2_source_bindings').get().host_path;
  for (const kind of ['warehouse', 'cache']) f.database.prepare('INSERT INTO v2_source_bindings VALUES(?,?,?,?,?)').run('dataset','node-1',kind,path,1);
  await f.admin.access.setReaders({resourceId: 'dataset', revision: 0, readers: ['bob']});
  for (const kind of ['warehouse', 'cache']) {
    const request = {machineId: 'node-1', source: {kind, datasetId: 'training', version}};
    assert.equal((await f.member.data.resolveReadLocation(request)).availability, 'available');
    await assert.rejects(f.member.data.resolveReadLocation({...request, source: {...request.source, version: 'b'.repeat(64)}}), hasCode('FORBIDDEN'));
  }
});

test('stale concurrent edits and unknown recipients cannot overwrite a complete reader list', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.admin.access.setReaders(change(0, ['bob'])), f.admin.access.setReaders(change(0, []))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'DATA_ACCESS_CHANGED');
  const current = await f.admin.access.get({resourceId: 'images'});
  await assert.rejects(f.admin.access.setReaders(change(1, ['missing'])), hasCode('ACCOUNT_NOT_FOUND'));
  assert.deepEqual(await f.admin.access.get({resourceId: 'images'}), current);
});

test('failure after reader replacement rolls back both reader list and revision', async t => {
  const f = await fixture(t);
  const current = await f.admin.access.setReaders(change(0, ['bob']));
  f.database.exec("CREATE TRIGGER fail_acl BEFORE UPDATE ON v2_data_resources BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(f.admin.access.setReaders(change(1, [])), hasCode('INTERNAL_ERROR'));
  assert.deepEqual(await f.admin.access.get({resourceId: 'images'}), current);
});

test('revoked admin cannot read or modify access; duplicate readers and owner reassignment are rejected', async t => {
  const f = await fixture(t);
  for (const value of [change(0, ['bob', 'bob']), {...change(0, []), ownerId: 'bob'}]) {
    assert.throws(() => parseDataReaders(value), hasCode('INVALID_REQUEST'));
  }
  f.database.exec("UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id='alice'");
  await assert.rejects(f.admin.access.get({resourceId: 'images'}), hasCode('UNAUTHENTICATED'));
  await assert.rejects(f.admin.access.setReaders(change(0, ['bob'])), hasCode('UNAUTHENTICATED'));
});

test('lost ACL write response remains unconfirmed and is never replayed automatically', async t => {
  const f = await fixture(t);
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl, session: f.admin.transport.session,
    fetch: async (url, options) => {await fetch(url, options); throw new Error('lost response');}});
  await assert.rejects(new DataAccessClient({transport}).setReaders(change(0, ['bob'])), hasCode('NETWORK_UNAVAILABLE'));
  assert.deepEqual((await f.admin.access.get({resourceId: 'images'})).readers, ['bob']);
  assert.equal(f.calls.filter(path => path === '/api/v2/data-access/set-readers').length, 1);
});
