import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {publishedFixture, python} from './helpers/v2-published-fixture.mjs';
import {planDataAccessImport} from '../src/domain/data-access-import.mjs';
import {ManagedSourceReader} from '../src/infrastructure/managed-source-reader.mjs';

const version = 'a'.repeat(64);
const observations = ['cache', 'warehouse'].map(kind => ({machineId: 'node-1', source: {kind, datasetId: 'images', version},
  legacyOwners: ['alice', 'old-bob'], snapshotId: 'b'.repeat(64)}));
function inputs() {
  return {resource: {resourceId: 'images', datasetId: 'images', version, ownerId: 'alice-v2', visibility: 'private', revision: 0,
    readers: [], bindings: observations.map(row => ({machineId: row.machineId, kind: row.source.kind}))},
    observations: structuredClone(observations), accountMapping: [{legacyId: 'alice', accountId: 'alice-v2'}, {legacyId: 'old-bob', accountId: 'bob-v2'}],
    knownAccountIds: ['alice-v2', 'bob-v2']};
}

test('real legacy ACL export includes every reader and produces a non-mutating import proposal', async t => {
  const f = await publishedFixture(t, {owners: ['alice', 'old-bob']});
  const file = join(f.directory, 'warehouse', '.registry', 'images', 'dataset.json');
  const before = await readFile(file);
  const snapshots = [];
  for (const kind of ['cache', 'warehouse']) snapshots.push(await f.managed.exportAccess(f.request(kind), {actor: {id: 'alice'}}));
  assert.deepEqual(snapshots[0].legacyOwners, ['alice', 'old-bob']);
  assert.match(snapshots[0].snapshotId, /^[a-f0-9]{64}$/);
  const input = inputs(); input.resource.version = f.version; input.observations = snapshots;
  const untouched = structuredClone(input);
  const proposal = planDataAccessImport(input);
  assert.equal(proposal.state, 'proposed');
  assert.deepEqual(proposal.readers, ['bob-v2']);
  assert.deepEqual(proposal.snapshots, snapshots.map(({machineId, source, snapshotId}) => ({machineId, source, snapshotId})));
  assert.deepEqual(input, untouched);
  assert.deepEqual(await readFile(file), before);
  assert.equal(proposal.expectedRevision, 0);
});

test('migration export retains old ACL checks even for a coordinator-delegated version', async t => {
  const f = await publishedFixture(t);
  const reader = new ManagedSourceReader({machineId: 'node-1', roots: f.roots, python, coordinatorVersions: [f.request('warehouse').source]});
  assert.equal((await reader.inspect(f.request('warehouse'), {actor: {id: 'bob'}})).availability, 'available');
  await assert.rejects(reader.exportAccess(f.request('warehouse'), {actor: {id: 'bob'}}), error => error.code === 'FORBIDDEN');
});

test('missing/unknown mappings are named instead of dropping existing readers', () => {
  const input = inputs(); input.accountMapping.pop();
  assert.deepEqual(planDataAccessImport(input), {state: 'blocked', resourceId: 'images', reason: 'ACCOUNT_MAPPING_REQUIRED', accounts: ['old-bob']});
  const unknown = inputs(); unknown.knownAccountIds = ['alice-v2'];
  assert.deepEqual(planDataAccessImport(unknown).accounts, ['bob-v2']);
  assert.equal(planDataAccessImport(unknown).reason, 'TARGET_ACCOUNT_NOT_FOUND');
});

test('all replicas must be present and agree; no union is silently used', () => {
  const missing = inputs(); missing.observations.pop();
  assert.equal(planDataAccessImport(missing).reason, 'SOURCE_SNAPSHOTS_REQUIRED');
  const different = inputs(); different.observations[1].legacyOwners = ['alice'];
  assert.equal(planDataAccessImport(different).reason, 'REPLICA_ACL_CONFLICT');
  const extra = inputs(); extra.observations[1].machineId = 'unregistered';
  assert.equal(planDataAccessImport(extra).reason, 'UNREGISTERED_SOURCE_SNAPSHOT');
  const wrong = inputs(); wrong.observations[1].source.version = 'c'.repeat(64);
  assert.equal(planDataAccessImport(wrong).reason, 'SOURCE_IDENTITY_MISMATCH');
});

test('current V2 revocations, owner changes and shared visibility require explicit review', () => {
  const revoked = inputs(); revoked.resource.revision = 2;
  assert.equal(planDataAccessImport(revoked).reason, 'EXISTING_V2_ACL_CONFLICT');
  const owner = inputs(); owner.resource.ownerId = 'other';
  assert.equal(planDataAccessImport(owner).reason, 'RESOURCE_OWNER_CONFLICT');
  const shared = inputs(); shared.resource.visibility = 'shared';
  assert.equal(planDataAccessImport(shared).reason, 'SHARED_SOURCE_REQUIRES_REVIEW');
  const same = inputs(); same.resource.revision = 2; same.resource.readers = ['bob-v2'];
  assert.equal(planDataAccessImport(same).state, 'proposed');
});

test('ambiguous mappings and duplicate replica observations do not produce an import proposal', () => {
  const mapping = inputs(); mapping.accountMapping.push({...mapping.accountMapping[0]});
  assert.equal(planDataAccessImport(mapping).reason, 'DUPLICATE_ACCOUNT_MAPPING');
  const duplicate = inputs(); duplicate.observations.push(structuredClone(duplicate.observations[0]));
  assert.equal(planDataAccessImport(duplicate).reason, 'DUPLICATE_SOURCE_SNAPSHOT');
});

test('oversized reader sets are reported for review, never truncated to fit the current write contract', () => {
  const input = inputs();
  const readers = Array.from({length: 101}, (_, n) => 'reader-' + n);
  input.observations.forEach(row => row.legacyOwners = ['alice', ...readers]);
  input.accountMapping = [{legacyId: 'alice', accountId: 'alice-v2'}, ...readers.map(id => ({legacyId: id, accountId: id}))];
  input.knownAccountIds = ['alice-v2', ...readers];
  assert.equal(planDataAccessImport(input).reason, 'READER_LIMIT_REQUIRES_REVIEW');
});
