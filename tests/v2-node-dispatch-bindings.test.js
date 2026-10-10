import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dirname} from 'node:path';
import net from 'node:net';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {LookupNodeDispatch} from '../src/application/lookup-node-dispatch.mjs';
import {GpuqReceiptReader} from '../src/infrastructure/gpuq-receipt-reader.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'v2-node-binding-')), path = join(folder, 'node.sqlite');
  const db = new DatabaseSync(path); t.after(async () => {db.close(); await rm(folder, {recursive: true, force: true});});
  createNodeDispatchBindingsSchema(db);
  const binding = {dispatchId: randomUUID(), jobId: randomUUID(), accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    requestHash: 'a'.repeat(64), nativeDigest: 'b'.repeat(64), nativeOwner: 'runtime-alice', nativeName: 'training'};
  const bindings = new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'});
  const receipt = {job_id: 'J0123456789ab', submit_key: binding.dispatchId, submit_digest: binding.nativeDigest,
    owner: binding.nativeOwner, name: binding.nativeName, gpu_count: binding.gpuCount, state: 'PENDING'};
  return {db, path, binding, bindings, receipt, reference: {machineId: 'node-1', dispatchId: binding.dispatchId}};
}

test('fixed node binding persists separately from the coordinator and is idempotent across reopen', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.bindings.bind(f.binding), f.binding);
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(f.bindings.bind({...f.binding}), f.binding);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  const db = new DatabaseSync(f.path, {readOnly: true});
  try {assert.deepEqual(new SqliteNodeDispatchBindings({database: db, machineId: 'node-1'}).get(f.reference), f.binding);}
  finally {db.close();}
});

test('dispatch identity, account, platform hash and native launch identity cannot be rebound', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding);
  for (const change of [{jobId: randomUUID()}, {accountId: 'bob'}, {gpuCount: 3}, {requestHash: 'c'.repeat(64)},
    {nativeDigest: 'c'.repeat(64)}, {nativeOwner: 'other'}, {nativeName: 'other'}]) {
    assert.throws(() => f.bindings.bind({...f.binding, ...change}), hasCode('NODE_DISPATCH_BINDING_CONFLICT'));
  }
  assert.throws(() => f.bindings.bind({...f.binding, machineId: 'node-2'}), hasCode('NODE_DISPATCH_MACHINE_MISMATCH'));
  assert.throws(() => f.bindings.get({...f.reference, machineId: 'node-2'}), hasCode('NODE_DISPATCH_MACHINE_MISMATCH'));
});

test('lookup queries only the original submit key and projects the platform acceptance without native metadata', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding); const calls = [];
  const app = new LookupNodeDispatch({bindings: f.bindings, native: {async lookup(input) {calls.push(input); return f.receipt;}}});
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(await app.execute(f.reference), {dispatchId: f.binding.dispatchId, jobId: f.binding.jobId,
    machineId: 'node-1', accountId: 'alice', gpuCount: 2, requestHash: f.binding.requestHash, nodeJobId: f.receipt.job_id});
  assert.deepEqual(calls, [{submitKey: f.binding.dispatchId}]);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('missing mapping or native receipt stays unconfirmed with no registration or resubmission', async t => {
  const f = await fixture(t); let calls = 0;
  const app = new LookupNodeDispatch({bindings: f.bindings, native: {async lookup() {calls++; return null;}}});
  assert.equal(await app.execute(f.reference), null); assert.equal(calls, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_node_dispatch_bindings').get().n, 0);
  f.bindings.bind(f.binding);
  assert.equal(await app.execute(f.reference), null); assert.equal(calls, 1);
});

test('wrong native key, digest, owner, name or GPU count is never treated as acceptance', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding);
  for (const change of [{submit_key: randomUUID()}, {submit_digest: f.binding.requestHash}, {owner: 'other'},
    {name: 'other'}, {gpu_count: 3}, {job_id: '../path'}]) {
    const app = new LookupNodeDispatch({bindings: f.bindings, native: {async lookup() {return {...f.receipt, ...change};}}});
    await assert.rejects(app.execute(f.reference), hasCode('NATIVE_DISPATCH_RECEIPT_MISMATCH'));
  }
});

test('node lookup uses the actual Python native protocol bridge without submitting or scanning jobs', async t => {
  const f = await fixture(t); f.bindings.bind(f.binding);
  const socketPath = join(dirname(f.path), 'receipt.sock'), requests = [];
  let response = f.receipt, rejected = false;
  const server = net.createServer(socket => {
    let body = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      body += chunk; if (!body.endsWith('\n')) return;
      const request = JSON.parse(body); requests.push(request);
      socket.end(JSON.stringify(rejected ? {request_id: request.request_id, ok: false, error: {code: 'NOT_FOUND', message: 'old daemon'}}
        : {request_id: request.request_id, ok: true, result: response}) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const native = new GpuqReceiptReader({socketPath, python: process.env.V2_PYTHON || 'python3'});
  const app = new LookupNodeDispatch({bindings: f.bindings, native});
  assert.equal((await app.execute(f.reference)).nodeJobId, f.receipt.job_id);
  response = null;
  assert.equal(await app.execute(f.reference), null);
  rejected = true;
  await assert.rejects(app.execute(f.reference), hasCode('GPUQ_RECEIPT_UNAVAILABLE'));
  assert.ok(requests.every(request => request.op === 'submission_receipt' && request.args.submit_key === f.binding.dispatchId));
  assert.equal(requests.length, 3);
});
