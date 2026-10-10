import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GpuqLaunchSpec} from '../src/infrastructure/gpuq-launch-spec.mjs';

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
