import test from 'node:test';
import assert from 'node:assert/strict';
import {ResolveTrainingData} from '../src/application/resolve-training-data.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';

const actor = {id: 'alice'}, version = 'a'.repeat(64);
const directory = {kind: 'directory', sourceId: 'images'};
const warehouse = {kind: 'warehouse', datasetId: 'imagenet', version};
const request = {machineId: 'node-1', sources: [directory, warehouse]};
const hasCode = code => error => error.code === code;

test('training reads retain exact source versions and reuse direct-read paths without preparation', async () => {
  const calls = [], grants = [];
  const app = new ResolveTrainingData({access: {async requireRead(who, ref) {assert.equal(who, actor); grants.push(ref);}},
    sources: {async inspect(ref) {calls.push(ref); return {availability: 'available'};}}});
  const reads = await app.execute(actor, request);
  assert.deepEqual(calls, request.sources.map(source => ({machineId: 'node-1', source})));
  assert.deepEqual(grants.slice(0, 2), calls);
  assert.deepEqual(reads.map(row => row.location), [
    {containerPath: '/datasets/images', readOnly: true}, {containerPath: '/data2/imagenet', readOnly: true},
  ]);
  assert.deepEqual(reads[1].source, warehouse);
});

test('conflicting container paths cannot silently shadow another version or cache source', async () => {
  let calls = 0;
  const app = new ResolveTrainingData({access: {async requireRead() {calls++;}}, sources: {async inspect() {calls++;}}});
  for (const sources of [[directory, directory], [warehouse, {...warehouse, kind: 'cache'}], [warehouse, {...warehouse, version: 'b'.repeat(64)}]]) {
    await assert.rejects(app.execute(actor, {...request, sources}), hasCode('TRAINING_DATA_PATH_CONFLICT'));
  }
  assert.equal(calls, 0);
});

test('all sources require authorization before any filesystem observation', async () => {
  let calls = 0;
  const app = new ResolveTrainingData({access: {async requireRead(_actor, ref) {
    if (ref.source.kind === 'warehouse') throw new ApplicationError('FORBIDDEN');
  }}, sources: {async inspect() {calls++;}}});
  await assert.rejects(app.execute(actor, request), hasCode('FORBIDDEN'));
  assert.equal(calls, 0);
});

test('a source revoked during another observation invalidates earlier successful reads', async () => {
  let revoked = false;
  const app = new ResolveTrainingData({access: {async requireRead(_actor, ref) {
    if (revoked && ref.source.kind === 'directory') throw new ApplicationError('FORBIDDEN');
  }}, sources: {async inspect(ref) {
    if (ref.source.kind === 'warehouse') revoked = true;
    return {availability: 'available'};
  }}});
  await assert.rejects(app.execute(actor, request), hasCode('FORBIDDEN'));
});

test('missing or incomplete data never starts a transfer or returns a partial read set', async () => {
  for (const state of [{availability: 'missing', reason: 'not-found'}, {availability: 'unavailable', reason: 'not-ready'}]) {
    const calls = [];
    const app = new ResolveTrainingData({access: {async requireRead() {}}, sources: {async inspect(ref) {calls.push(ref); return state;}}});
    await assert.rejects(app.execute(actor, request), hasCode('TRAINING_DATA_UNAVAILABLE'));
    assert.equal(calls.length, 1);
  }
});
