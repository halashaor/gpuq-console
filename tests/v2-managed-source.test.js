import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {stat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {publishedFixture as fixture, python} from './helpers/v2-published-fixture.mjs';
import {ManagedSourceReader} from '../src/infrastructure/managed-source-reader.mjs';
import {assembleNodeSourceReader} from '../src/bootstrap/node-source-reader.mjs';
import {HttpSourceReader} from '../src/infrastructure/http-source-reader.mjs';
import {createSourceInspectionHandler} from '../src/api/source-inspection-handler.mjs';
import {parseSourceInspection} from '../src/contracts/source-inspection.mjs';

const context = {actor: {id: 'alice'}}, hasCode = code => error => error.code === code;

test('Node adapter invokes real Python metadata verification for cache and warehouse without changing payload', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'cache', 'ready', 'images', f.version, 'data', 'sample.txt');
  const before = await stat(file);
  for (const kind of ['cache', 'warehouse']) assert.deepEqual(await f.managed.inspect(f.request(kind), context), {availability: 'available'});
  const after = await stat(file);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(file, 'utf8'), 'original sample');
  await assert.rejects(f.managed.inspect(f.request('cache'), {actor: {id: 'bob'}}), hasCode('FORBIDDEN'));
  await assert.rejects(f.managed.inspect(f.request('cache')), hasCode('UNAUTHENTICATED'));
});

test('coordinator forwards only account ID and receives a real node/Python managed observation', async t => {
  const f = await fixture(t), credential = 'c'.repeat(64);
  let received;
  const nodeReader = assembleNodeSourceReader({machineId: 'node-1', managedRoots: f.roots, python,
    directoryCatalog: {find() {throw new Error('must not fall back to directory');}}});
  const handler = createSourceInspectionHandler({machineId: 'node-1', credential, reportError() {}, sources: {
    inspect(request, value) {received = value; return nodeReader.inspect(request, value);},
  }});
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const reader = new HttpSourceReader({nodes: [{machineId: 'node-1', origin: `http://127.0.0.1:${server.address().port}`, credential}]});
  assert.deepEqual(await reader.inspect(f.request('warehouse'), {actor: {id: 'alice', sessionId: 'private-session'}}), {availability: 'available'});
  assert.deepEqual(received, {actor: {id: 'alice'}});
  await assert.rejects(reader.inspect(f.request('cache'), {actor: {id: 'bob'}}), hasCode('FORBIDDEN'));
});

test('unknown root or version is unconfirmed, never an implicit preparation or cache fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(f.managed.inspect({...f.request('cache'), source: {...f.request('cache').source, version: '0'.repeat(64)}}, context), hasCode('SOURCE_UNAVAILABLE'));
  const missingRoot = join(f.directory, 'uninitialized');
  const missing = new ManagedSourceReader({machineId: 'node-1', roots: [{kind: 'cache', root: missingRoot}], python});
  await assert.rejects(missing.inspect(f.request('cache'), context), hasCode('SOURCE_UNAVAILABLE'));
  await assert.rejects(stat(missingRoot), {code: 'ENOENT'});
  await assert.rejects(missing.inspect(f.request('warehouse'), context), hasCode('SOURCE_UNAVAILABLE'));
  await assert.rejects(f.managed.inspect({...f.request('cache'), machineId: 'other'}, context), hasCode('SOURCE_NODE_MISMATCH'));
});

test('node identity envelope rejects user tokens, admin flags and malformed account identifiers', () => {
  const request = {machineId: 'node-1', source: {kind: 'directory', sourceId: 'images'}};
  assert.deepEqual(parseSourceInspection({accountId: 'alice', request}), {accountId: 'alice', request});
  for (const envelope of [{accountId: 'alice', request, hostAdmin: true}, {accountId: 'alice', request, token: 'secret'}, {accountId: '../alice', request}]) {
    assert.throws(() => parseSourceInspection(envelope), hasCode('INVALID_REQUEST'));
  }
});
