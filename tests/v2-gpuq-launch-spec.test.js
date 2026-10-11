import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GpuqLaunchSpec} from '../src/infrastructure/gpuq-launch-spec.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {PrepareNodeDispatch} from '../src/application/prepare-node-dispatch.mjs';
import {nativeDispatchAcceptance} from '../src/domain/node-dispatch.mjs';

const inventory = {gpuUuids: ['GPU-a', 'GPU-b']};
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'v2-native-launch-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const runner = join(cwd, 'approved-runner');
  await writeFile(runner, 'synthetic executable, must never run'); await chmod(runner, 0o700);
  return {cwd, raw: {submit_key: randomUUID(), name: 'native-test', owner: 'test-user', priority: 2,
    dispatch_mode: 'queue', checkpoint_capability: 'none', restart_policy: 'never', yield_policy: 'never',
    gpu_count: 1, placement: 'any', requested_gpu_uuids: [], argv: [runner, '--literal', '$(no-shell)'], cwd,
    env: {Z: 'last', A: 'first'}}};
}

test('native launch builder normalizes without execution or database writes and hashes the same canonical payload', async t => {
  const f = await fixture(t), builder = new GpuqLaunchSpec({python: process.env.V2_PYTHON || 'python3'});
  const before = await readdir(f.cwd), raw = structuredClone(f.raw);
  const result = await builder.build(f.raw, inventory);
  assert.equal(result.submission.min_gpu_count, 1); assert.equal(result.submission.elastic_gpu_count, false);
  assert.deepEqual(result.submission.argv, f.raw.argv); assert.match(result.nativeDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.raw, raw); assert.deepEqual(await readdir(f.cwd), before);
  const reordered = await builder.build({...f.raw, env: {A: 'first', Z: 'last'}}, inventory);
  assert.equal(reordered.nativeDigest, result.nativeDigest);
  assert.notEqual((await builder.build({...f.raw, argv: [...f.raw.argv, '--changed']}, inventory)).nativeDigest, result.nativeDigest);
});

test('native path, placement and wire-size validation are not bypassed by digest preparation', async t => {
  const f = await fixture(t), builder = new GpuqLaunchSpec({python: process.env.V2_PYTHON || 'python3'});
  for (const changed of [{cwd: join(f.cwd, 'missing')}, {argv: ['relative-runner']},
    {placement: 'pinned', requested_gpu_uuids: ['GPU-outside']}, {submit_key: 'not-a-uuid'}]) {
    await assert.rejects(builder.build({...f.raw, ...changed}, inventory), error => error.code === 'INVALID_NATIVE_SUBMISSION');
  }
  await assert.rejects(new GpuqLaunchSpec({maxRequestBytes: 64}).build(f.raw, inventory), error => error.code === 'INVALID_NATIVE_SUBMISSION');
  await assert.rejects(builder.build(f.raw, {gpuUuids: ['GPU-a', 'GPU-a']}), error => error.code === 'GPU_INVENTORY_INVALID');
});

test('node preparation derives a fixed native binding without confusing initial allocation and elastic maximum', async t => {
  const f = await fixture(t), db = new DatabaseSync(':memory:'); t.after(() => db.close());
  createNodeDispatchBindingsSchema(db);
  const bindings = new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'});
  const app = new PrepareNodeDispatch({bindings, launchSpec: new GpuqLaunchSpec({python: process.env.V2_PYTHON || 'python3'})});
  const identity = {dispatchId: f.raw.submit_key, jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 2, requestHash: 'a'.repeat(64)};
  const raw = {...f.raw, gpu_count: 4, min_gpu_count: 1, elastic_gpu_count: true, auto_scale_up: true,
    checkpoint_capability: 'epoch-v1', restart_policy: 'on-preempt', yield_policy: 'save',
    target_global_batch_size: 64, per_device_micro_batch_size: 4};
  const pool = {gpuUuids: ['GPU-a', 'GPU-b', 'GPU-c', 'GPU-d']};
  const result = await app.execute(identity, raw, pool);
  assert.equal(result.binding.gpuCount, 2); assert.equal(result.binding.nativeMaxGpus, 4);
  assert.equal(result.submission.gpu_count, 4); assert.equal(result.submission.auto_scale_up, true);
  const accepted = nativeDispatchAcceptance(result.binding, {job_id: 'J0123456789ab', submit_key: identity.dispatchId,
    submit_digest: result.binding.nativeDigest, owner: raw.owner, name: raw.name, gpu_count: 4});
  assert.equal(accepted.gpuCount, 2);
  assert.deepEqual(await app.execute(identity, raw, pool), result);
  await assert.rejects(app.execute(identity, {...raw, argv: [...raw.argv, '--different']}, pool), error => error.code === 'NODE_DISPATCH_BINDING_CONFLICT');
});

test('node preparation rejects an illegal initial count or changed submit key before persisting a binding', async t => {
  const f = await fixture(t), db = new DatabaseSync(':memory:'); t.after(() => db.close()); createNodeDispatchBindingsSchema(db);
  const app = new PrepareNodeDispatch({bindings: new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'}),
    launchSpec: new GpuqLaunchSpec({python: process.env.V2_PYTHON || 'python3'})});
  const identity = {dispatchId: f.raw.submit_key, jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 3, requestHash: 'a'.repeat(64)};
  const raw = {...f.raw, gpu_count: 4, min_gpu_count: 1, elastic_gpu_count: true, target_global_batch_size: 64, per_device_micro_batch_size: 4};
  const pool = {gpuUuids: ['GPU-a', 'GPU-b', 'GPU-c', 'GPU-d']};
  await assert.rejects(app.execute(identity, raw, pool), error => error.code === 'NODE_INITIAL_GPU_COUNT_INVALID');
  await assert.rejects(app.execute({...identity, gpuCount: 2}, {...raw, submit_key: randomUUID()}, pool), error => error.code === 'NODE_LAUNCH_IDENTITY_MISMATCH');
  assert.equal(db.prepare('SELECT count(*) n FROM v2_node_dispatch_bindings').get().n, 0);
});
