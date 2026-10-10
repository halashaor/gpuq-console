import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GpuqPoolReader} from '../src/infrastructure/gpuq-pool-reader.mjs';

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
  return {...state, state, reader: new GpuqPoolReader({machineId: 'node-1', socketPath, python: process.env.V2_PYTHON || 'python3'})};
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
