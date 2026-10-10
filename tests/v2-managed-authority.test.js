import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {publishedFixture, python} from './helpers/v2-published-fixture.mjs';
import {ManagedSourceReader} from '../src/infrastructure/managed-source-reader.mjs';
import {HttpSourceReader} from '../src/infrastructure/http-source-reader.mjs';
import {createSourceInspectionHandler} from '../src/api/source-inspection-handler.mjs';
import {assembleSqliteDataRead} from '../src/bootstrap/sqlite-data-read.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataAccessClient} from '../src/client/data-access-client.mjs';
import {ComputePolicyClient} from '../src/client/compute-policy-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {ClientSession} from '../src/client/session.mjs';
import {parseSourceInspection} from '../src/contracts/source-inspection.mjs';

const hasCode = code => error => error.code === code;
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('exact node-configured delegation leaves other managed locations on their original ACL', async t => {
  const f = await publishedFixture(t);
  const reader = new ManagedSourceReader({machineId: 'node-1', roots: f.roots, python,
    coordinatorVersions: [f.request('warehouse').source]});
  assert.deepEqual(await reader.inspect(f.request('warehouse'), {actor: {id: 'bob'}}), {availability: 'available'});
  await assert.rejects(reader.inspect(f.request('cache'), {actor: {id: 'bob'}}), hasCode('FORBIDDEN'));
  await assert.rejects(f.managed.inspect(f.request('warehouse'), {actor: {id: 'bob'}}), hasCode('FORBIDDEN'));
});

test('V2 alone grants/revokes delegated reads through real coordinator/node/Python without rewriting legacy ACL', async t => {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  const published = await publishedFixture(t);
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice';
    UPDATE v2_machines SET cards=8 WHERE id='node-1'`);
  f.database.prepare("INSERT INTO v2_data_resources(id,kind,source_id,version,visibility,owner_id) VALUES('published','dataset','images',?,'private','alice')")
    .run(published.version);
  const adminTransport = new JsonHttpTransport({baseUrl: f.baseUrl});
  await new SessionClient({transport: adminTransport, delivery: 'token'}).login(loginRequest);
  const access = new DataAccessClient({transport: adminTransport});
  await new ComputePolicyClient({transport: adminTransport}).set({accountId: 'bob', revision: 0, totalCards: 1, limits: [{machineId: 'node-1', maxCards: 1}]});
  const memberTransport = new JsonHttpTransport({baseUrl: f.baseUrl});
  await new SessionClient({transport: memberTransport, delivery: 'token'}).login({...loginRequest, username: 'bob'});
  const reader = new ManagedSourceReader({machineId: 'node-1', roots: published.roots, python,
    coordinatorVersions: [published.request('warehouse').source]});
  let calls = 0, revokeDuringRead = false;
  const credential = 'd'.repeat(64);
  const nodeOrigin = await serve(t, createSourceInspectionHandler({machineId: 'node-1', credential, sources: {
    async inspect(request, context) {
      calls++;
      const result = await reader.inspect(request, context);
      if (revokeDuringRead) await access.setReaders({resourceId: 'published', revision: 1, readers: []});
      return result;
    },
  }}));
  let handler;
  const origin = await serve(t, (req, res) => handler(req, res));
  handler = assembleSqliteDataRead({database: f.database, publicOrigin: origin, sources: new HttpSourceReader({
    nodes: [{machineId: 'node-1', origin: nodeOrigin, credential}],
  })});
  const data = new DataClient({transport: new JsonHttpTransport({baseUrl: origin,
    session: new ClientSession({headers: memberTransport.session.snapshot().headers})})});
  const ownersFile = join(published.directory, 'warehouse', '.registry', 'images', 'dataset.json');
  const before = await readFile(ownersFile);
  await assert.rejects(data.resolveReadLocation(published.request('warehouse')), hasCode('FORBIDDEN'));
  assert.equal(calls, 0);
  await access.setReaders({resourceId: 'published', revision: 0, readers: ['bob']});
  assert.equal((await data.resolveReadLocation(published.request('warehouse'))).availability, 'available');
  await assert.rejects(data.resolveReadLocation(published.request('cache')), hasCode('FORBIDDEN'));
  revokeDuringRead = true;
  await assert.rejects(data.resolveReadLocation(published.request('warehouse')), hasCode('FORBIDDEN'));
  const afterRevoke = calls;
  await assert.rejects(data.resolveReadLocation(published.request('warehouse')), hasCode('FORBIDDEN'));
  assert.equal(calls, afterRevoke);
  assert.deepEqual(await readFile(ownersFile), before);
});

test('neither the caller nor an ambiguous node configuration can select delegation', () => {
  const source = {kind: 'warehouse', datasetId: 'images', version: 'a'.repeat(64)};
  assert.throws(() => parseSourceInspection({accountId: 'bob', request: {machineId: 'node-1', source}, coordinatorVersion: source}), hasCode('INVALID_REQUEST'));
  assert.throws(() => new ManagedSourceReader({machineId: 'node-1', roots: [{kind: 'warehouse', root: '/data/warehouse'}], coordinatorVersions: [source, source]}), /Invalid/);
  assert.throws(() => new ManagedSourceReader({machineId: 'node-1', roots: [], coordinatorVersions: [source]}), /Invalid/);
});
