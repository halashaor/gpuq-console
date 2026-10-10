import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {publishedFixture} from './helpers/v2-published-fixture.mjs';
import {HttpSourceReader} from '../src/infrastructure/http-source-reader.mjs';
import {createSourceInspectionHandler} from '../src/api/source-inspection-handler.mjs';
import {SOURCE_ACCESS_ROUTE, parseSourceAccessResult} from '../src/contracts/source-inspection.mjs';

const credential = 'f'.repeat(64), context = {actor: {id: 'alice'}}, hasCode = code => error => error.code === code;
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('remote export returns the same complete ACL snapshot as native verification and retains old-owner checks', async t => {
  const f = await publishedFixture(t, {owners: ['alice', 'old-bob']});
  const origin = await serve(t, createSourceInspectionHandler({machineId: 'node-1', credential, sources: f.managed}));
  const reader = new HttpSourceReader({nodes: [{machineId: 'node-1', origin, credential}]});
  const request = f.request('warehouse');
  assert.deepEqual(await reader.exportAccess(request, context), await f.managed.exportAccess(request, context));
  await assert.rejects(reader.exportAccess(request, {actor: {id: 'stranger'}}), hasCode('FORBIDDEN'));
  const denied = await fetch(origin + SOURCE_ACCESS_ROUTE, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({accountId: 'alice', request})});
  assert.equal(denied.status, 401);
});

test('wrong-node and malformed snapshot responses remain unconfirmed and are never retried', async t => {
  const request = {machineId: 'node-1', source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}};
  for (const result of [
    {...request, machineId: 'other', legacyOwners: ['alice'], snapshotId: 'b'.repeat(64)},
    {...request, legacyOwners: ['alice', 'alice'], snapshotId: 'b'.repeat(64)},
    {...request, legacyOwners: ['alice'], snapshotId: 'invalid'},
  ]) {
    let calls = 0;
    const origin = await serve(t, (req, res) => {calls++; res.end(JSON.stringify({result}));});
    const reader = new HttpSourceReader({nodes: [{machineId: 'node-1', origin, credential}]});
    await assert.rejects(reader.exportAccess(request, context), hasCode('SOURCE_NODE_UNAVAILABLE'));
    assert.equal(calls, 1);
  }
});

test('directory/host-path injection is rejected before export, and private fields cannot enter a snapshot', async t => {
  let calls = 0;
  const origin = await serve(t, createSourceInspectionHandler({machineId: 'node-1', credential, sources: {exportAccess() {calls++;}}}));
  for (const request of [
    {machineId: 'node-1', source: {kind: 'directory', sourceId: 'images'}},
    {machineId: 'node-1', source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}, hostPath: '/arbitrary'},
  ]) {
    const response = await fetch(origin + SOURCE_ACCESS_ROUTE, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${credential}`}, body: JSON.stringify({accountId: 'alice', request})});
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
  assert.throws(() => parseSourceAccessResult({machineId: 'node-1', source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}, legacyOwners: ['alice'], snapshotId: 'b'.repeat(64), hostPath: '/private'}), hasCode('INVALID_API_RESPONSE'));
});

test('node cannot relabel an adapter snapshot from another source as the requested source', async t => {
  const request = {machineId: 'node-1', source: {kind: 'cache', datasetId: 'images', version: 'a'.repeat(64)}};
  const origin = await serve(t, createSourceInspectionHandler({machineId: 'node-1', credential, reportError() {}, sources: {
    async exportAccess() {return {...request, source: {...request.source, datasetId: 'other'}, legacyOwners: ['alice'], snapshotId: 'b'.repeat(64)};},
  }}));
  const response = await fetch(origin + SOURCE_ACCESS_ROUTE, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${credential}`}, body: JSON.stringify({accountId: 'alice', request})});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error: {code: 'SOURCE_UNAVAILABLE'}});
});
