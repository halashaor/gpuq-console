import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HttpSourceReader} from '../src/infrastructure/http-source-reader.mjs';
import {LocalSourceReader} from '../src/infrastructure/local-source-reader.mjs';
import {createSourceInspectionHandler} from '../src/api/source-inspection-handler.mjs';
import {assembleSqliteDataRead} from '../src/bootstrap/sqlite-data-read.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {ClientSession} from '../src/client/session.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {SOURCE_INSPECTION_ROUTE} from '../src/contracts/source-inspection.mjs';
import {sessionFixture, loginRequest, readRequest} from './helpers/v2-session-fixture.mjs';

const credential = 'c'.repeat(64), hasCode = code => error => error.code === code;
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('coordinator reads the selected node with real HTTP and local-node inspection, not its own directory', async t => {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  const folder = await mkdtemp(join(tmpdir(), 'v2-source-nodes-')); t.after(() => rm(folder, {recursive: true, force: true}));
  const present = join(folder, 'present'); await mkdir(present);
  let first = 0, second = 0, revokeDuringRead = false;
  const nodes = [];
  for (const [machineId, path] of [['node-1', present], ['node-2', join(folder, 'absent')]]) {
    const sources = new LocalSourceReader({machineId, catalog: {find() {
      if (machineId === 'node-1') first++; else second++;
      if (revokeDuringRead) f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'");
      return {hostPath: path};
    }}});
    nodes.push({machineId, credential, origin: await listen(t, createSourceInspectionHandler({machineId, credential, sources}))});
  }
  f.database.exec("INSERT INTO v2_machines(id) VALUES('node-2')");
  f.database.exec("INSERT INTO v2_data_resources(id,kind,machine_id,source_id,visibility) VALUES('second','directory','node-2','images','shared')");
  let handler;
  const origin = await listen(t, (req, res) => handler(req, res));
  handler = assembleSqliteDataRead({database: f.database, publicOrigin: origin, sources: new HttpSourceReader({nodes})});
  const loginTransport = new JsonHttpTransport({baseUrl: f.baseUrl});
  await new SessionClient({transport: loginTransport, delivery: 'token'}).login(loginRequest);
  const transport = new JsonHttpTransport({baseUrl: origin, session: new ClientSession({headers: loginTransport.session.snapshot().headers})});
  const data = new DataClient({transport});
  assert.equal((await data.resolveReadLocation(readRequest)).availability, 'available');
  assert.equal((await data.resolveReadLocation({...readRequest, machineId: 'node-2'})).availability, 'missing');
  assert.deepEqual([first, second], [1, 1]);
  revokeDuringRead = true;
  await assert.rejects(data.resolveReadLocation(readRequest), hasCode('UNAUTHENTICATED'));
  assert.deepEqual([first, second], [2, 1]);
  await assert.rejects(data.resolveReadLocation(readRequest), hasCode('UNAUTHENTICATED'));
  assert.deepEqual([first, second], [2, 1]);
});

test('node rejects wrong coordinator credential, wrong machine and caller paths before filesystem work', async t => {
  let calls = 0;
  const origin = await listen(t, createSourceInspectionHandler({machineId: 'node-1', credential,
    sources: {inspect: async () => {calls++; return {availability: 'available'};}}, reportError() {}}));
  const post = (body, token) => fetch(origin + SOURCE_INSPECTION_ROUTE, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token}, body: JSON.stringify({request: body, accountId: 'alice'})});
  assert.equal((await post(readRequest, 'a'.repeat(64))).status, 401);
  assert.equal((await post({...readRequest, machineId: 'node-2'}, credential)).status, 409);
  assert.equal((await post({...readRequest, hostPath: '/arbitrary'}, credential)).status, 400);
  assert.equal(calls, 0);
});

test('node failures, mismatched replies, redirects and excessive bodies are not absence or readiness', async t => {
  for (const variant of ['failure', 'mismatch', 'redirect', 'large']) {
    let calls = 0;
    const origin = await listen(t, (req, res) => {
      calls++;
      if (variant === 'failure') {res.writeHead(503); res.end('private diagnostic');}
      else if (variant === 'redirect') {res.writeHead(302, {Location: '/elsewhere'}); res.end();}
      else if (variant === 'large') {res.end('x'.repeat(9000));}
      else {res.end(JSON.stringify({result: {machineId: 'wrong', source: readRequest.source, availability: 'missing', reason: 'not-found'}}));}
    });
    const reader = new HttpSourceReader({nodes: [{machineId: 'node-1', origin, credential}]});
    await assert.rejects(reader.inspect(readRequest, {actor: {id: 'alice'}}), hasCode('SOURCE_NODE_UNAVAILABLE'));
    assert.equal(calls, 1);
  }
});

test('timeout or unknown node never falls back to another node', async t => {
  let calls = 0;
  const origin = await listen(t, () => {calls++;});
  const reader = new HttpSourceReader({nodes: [{machineId: 'node-1', origin, credential}], timeoutMs: 50});
  await assert.rejects(reader.inspect(readRequest, {actor: {id: 'alice'}}), hasCode('SOURCE_NODE_UNAVAILABLE'));
  const observed = calls;
  await assert.rejects(reader.inspect({...readRequest, machineId: 'unknown'}, {actor: {id: 'alice'}}), hasCode('SOURCE_NODE_UNAVAILABLE'));
  assert.equal(calls, observed);
  assert.ok(calls <= 1);
});

test('node configuration disallows plaintext remote origins and duplicate machine identities', () => {
  assert.throws(() => new HttpSourceReader({nodes: [{machineId: 'node-1', origin: 'http://node.example', credential}]}), /Invalid/);
  const node = {machineId: 'node-1', origin: 'https://node.example', credential};
  assert.throws(() => new HttpSourceReader({nodes: [node, node]}), /Invalid/);
});
