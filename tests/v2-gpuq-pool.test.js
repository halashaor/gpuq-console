import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GpuqPoolReader} from '../src/infrastructure/gpuq-pool-reader.mjs';
import {assembleGpuPool} from '../src/bootstrap/gpu-pool.mjs';
import {HttpGpuPoolReader} from '../src/infrastructure/http-gpu-pool-reader.mjs';
import {GPU_POOL_ROUTE, parseGpuPoolObservation} from '../src/contracts/gpu-pool.mjs';
import {NodeJsonTransport} from '../src/infrastructure/node-json-transport.mjs';

const hasCode = code => error => error.code === code;
function status() {
  return {daemon: {boot_id: 'fixture-boot', health: 'ok', observe_only: false,
    native_release_gate: {state: 'ABSENT', valid: true}, managed_gpu_uuids: ['GPU-a', 'GPU-b', 'GPU-c'],
    schedulable_gpu_uuids: ['GPU-c'], capacity_health: 'partial', quarantined_gpus: [{uuid: 'GPU-a'}]},
  jobs: [{id: 'private-job', owner: 'private-owner'}]};
}
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'v2-pool-')), socketPath = join(folder, 'daemon.sock');
  const state = {value: status(), calls: [], mismatchedReply: false};
  const server = net.createServer(socket => {
    let body = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      body += chunk;
      if (!body.endsWith('\n')) return;
      const request = JSON.parse(body); state.calls.push(request);
      socket.end(JSON.stringify({request_id: state.mismatchedReply ? 'wrong' : request.request_id, ok: true, result: state.value}) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await rm(folder, {recursive: true, force: true});});
  return {socketPath, state, reader: new GpuqPoolReader({machineId: 'node-1', socketPath, python: process.env.V2_PYTHON || 'python3'})};
}

const credential = 'c'.repeat(64);
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('real native socket protocol reads the authoritative UUID pool and excludes job metadata', async t => {
  const f = await fixture(t), value = await f.reader.inspect({machineId: 'node-1'});
  assert.deepEqual(value, {machineId: 'node-1', bootId: 'fixture-boot', health: 'ok', dispatchEnabled: true,
    gpuUuids: ['GPU-a', 'GPU-b', 'GPU-c'], freeGpuUuids: ['GPU-c']});
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.calls[0].op, 'status');
  assert.deepEqual(f.state.calls[0].args, {limit: 1});
  assert.equal(JSON.stringify(value).includes('private'), false);
});

test('native observe-only, unhealthy and release-gated pools never advertise free dispatch capacity', async t => {
  const f = await fixture(t);
  for (const fields of [{observe_only: true}, {health: 'recovering'}, {health: 'degraded'},
    {native_release_gate: {state: 'PREPARED', valid: true}}, {native_release_gate: {state: 'ABSENT', valid: false}}]) {
    f.state.value = status(); Object.assign(f.state.value.daemon, fields);
    const value = await f.reader.inspect({machineId: 'node-1'});
    assert.equal(value.dispatchEnabled, false);
    assert.deepEqual(value.freeGpuUuids, []);
    assert.equal(value.gpuUuids.length, 3);
  }
});

test('incomplete or inconsistent native inventory is unavailable rather than guessed free', async t => {
  const f = await fixture(t);
  for (const fields of [{managed_gpu_uuids: ['GPU-a', 'GPU-a']}, {schedulable_gpu_uuids: ['GPU-outside']},
    {schedulable_gpu_uuids: ['GPU-c', 'GPU-c']}, {observe_only: null}, {managed_gpu_uuids: null}, {native_release_gate: {state: 'ABSENT'}}]) {
    f.state.value = status(); Object.assign(f.state.value.daemon, fields);
    await assert.rejects(f.reader.inspect({machineId: 'node-1'}), hasCode('GPU_POOL_UNAVAILABLE'));
  }
});

test('empty pool remains explicit, wrong-node requests do not contact the daemon, and reply IDs are verified', async t => {
  const f = await fixture(t);
  await assert.rejects(f.reader.inspect({machineId: 'node-2'}), hasCode('GPU_POOL_NODE_MISMATCH'));
  assert.equal(f.state.calls.length, 0);
  f.state.value.daemon.managed_gpu_uuids = []; f.state.value.daemon.schedulable_gpu_uuids = [];
  assert.deepEqual((await f.reader.inspect({machineId: 'node-1'})).gpuUuids, []);
  f.state.mismatchedReply = true;
  await assert.rejects(f.reader.inspect({machineId: 'node-1'}), hasCode('GPU_POOL_UNAVAILABLE'));
});

test('coordinator HTTP to node Python to native socket returns the same pool, including large inventories', async t => {
  const f = await fixture(t);
  const origin = await serve(t, assembleGpuPool({machineId: 'node-1', credential, socketPath: f.socketPath,
    python: process.env.V2_PYTHON || 'python3', reportError() {}}));
  const remote = new HttpGpuPoolReader({nodes: [{machineId: 'node-1', origin, credential}]});
  assert.deepEqual(await remote.inspect({machineId: 'node-1'}), await f.reader.inspect({machineId: 'node-1'}));
  const ids = Array.from({length: 4096}, (_, index) => `GPU-${index}`);
  f.state.value.daemon.managed_gpu_uuids = ids; f.state.value.daemon.schedulable_gpu_uuids = ids;
  assert.deepEqual((await remote.inspect({machineId: 'node-1'})).freeGpuUuids, ids);
  f.state.value.daemon.observe_only = true;
  assert.deepEqual((await remote.inspect({machineId: 'node-1'})).freeGpuUuids, []);
});

test('pool node authentication and exact request shape prevent socket or machine overrides', async t => {
  const f = await fixture(t);
  const origin = await serve(t, assembleGpuPool({machineId: 'node-1', credential, socketPath: f.socketPath, reportError() {}}));
  const post = (input, token) => fetch(origin + GPU_POOL_ROUTE, {method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}),
  }, body: JSON.stringify(input)});
  assert.equal((await post({machineId: 'node-1'})).status, 401);
  assert.equal((await post({machineId: 'other'}, credential)).status, 409);
  assert.equal((await post({machineId: 'node-1', socketPath: '/private'}, credential)).status, 400);
  assert.equal(f.state.calls.length, 0);
});

test('pool response identity and dispatch invariants are checked before returning capacity', async t => {
  const f = await fixture(t), valid = await f.reader.inspect({machineId: 'node-1'});
  for (const bad of [{...valid, health: 'recovering'}, {...valid, dispatchEnabled: false},
    {...valid, freeGpuUuids: ['GPU-outside']}, {...valid, gpuUuids: [...valid.gpuUuids, 'GPU-a']},
    {...valid, jobs: []}]) assert.throws(() => parseGpuPoolObservation(bad), hasCode('INVALID_API_RESPONSE'));
  const origin = await serve(t, (req, res) => res.end(JSON.stringify({result: {...valid, machineId: 'wrong-node'}})));
  const remote = new HttpGpuPoolReader({nodes: [{machineId: 'node-1', origin, credential}]});
  await assert.rejects(remote.inspect({machineId: 'node-1'}), hasCode('GPU_POOL_UNAVAILABLE'));
});

test('shared transport keeps the small default bound and rejects invalid or exceeded configured bounds', async () => {
  const nodes = [{machineId: 'node-1', origin: 'https://node.example', credential}];
  for (const maxResponseBytes of [0, -1, 2.5, 2 * 1024 * 1024 + 1]) {
    assert.throws(() => new NodeJsonTransport({nodes, maxResponseBytes}), /response limit/);
  }
  const fetch = async () => new Response(JSON.stringify({result: {payload: 'x'.repeat(10000)}}));
  await assert.rejects(new NodeJsonTransport({nodes, fetch}).request('node-1', GPU_POOL_ROUTE, {machineId: 'node-1'}), hasCode('NODE_UNAVAILABLE'));
  assert.equal((await new NodeJsonTransport({nodes, fetch, maxResponseBytes: 16384})
    .request('node-1', GPU_POOL_ROUTE, {machineId: 'node-1'})).payload.length, 10000);
});
