import {InvalidRequest, InvalidResponse} from './errors.mjs';
import {parseManagedRegistration} from './managed-registration.mjs';

export const DATA_ACCESS_IMPORT_ROUTES = {
  plan: '/api/v2/data-access-import/plan', apply: '/api/v2/data-access-import/apply', receipt: '/api/v2/data-access-import/receipt',
};
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const ids = value => Array.isArray(value) && value.every(id) && new Set(value).size === value.length;

export function parseImportPlanRequest(value) {
  if (!exact(value, ['resourceId']) || !id(value.resourceId)) throw new InvalidRequest('resourceId');
  return {resourceId: value.resourceId};
}
export function parseImportApplyRequest(value) {
  if (!exact(value, ['resourceId', 'requestId', 'planId'])) throw new InvalidRequest('request');
  const {resourceId} = parseImportPlanRequest({resourceId: value.resourceId});
  if (!uuid(value.requestId)) throw new InvalidRequest('requestId');
  if (!hash(value.planId)) throw new InvalidRequest('planId');
  return {resourceId, requestId: value.requestId, planId: value.planId};
}
export function parseImportReceiptRequest(value) {
  if (!exact(value, ['requestId']) || !uuid(value.requestId)) throw new InvalidRequest('requestId');
  return {requestId: value.requestId};
}

export function parseImportPlanResult(value) {
  try {
    if (value?.state === 'blocked') {
      if (!exact(value, ['state', 'resourceId', 'reason', 'accounts']) || !id(value.resourceId)
        || typeof value.reason !== 'string' || !/^[A-Z_]{1,80}$/.test(value.reason) || !ids(value.accounts)) throw new InvalidResponse();
      return {state: 'blocked', resourceId: value.resourceId, reason: value.reason, accounts: [...value.accounts]};
    }
    if (!exact(value, ['state', 'resourceId', 'expectedRevision', 'ownerId', 'readers', 'accountMapping', 'snapshots', 'planId'])
      || value.state !== 'proposed' || !id(value.resourceId) || !id(value.ownerId) || !hash(value.planId)
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !ids(value.readers) || value.readers.length > 100
      || !Array.isArray(value.accountMapping) || !value.accountMapping.length
      || !Array.isArray(value.snapshots) || !value.snapshots.length) throw new InvalidResponse();
    const legacyIds = new Set();
    const accountMapping = value.accountMapping.map(row => {
      if (!exact(row, ['legacyId', 'accountId']) || !id(row.legacyId) || !id(row.accountId) || legacyIds.has(row.legacyId)) throw new InvalidResponse();
      legacyIds.add(row.legacyId); return {legacyId: row.legacyId, accountId: row.accountId};
    });
    const locations = new Set();
    const snapshots = value.snapshots.map(row => {
      if (!exact(row, ['machineId', 'source', 'snapshotId']) || !hash(row.snapshotId)) throw new InvalidResponse();
      const reference = parseManagedRegistration({machineId: row.machineId, source: row.source});
      const key = `${reference.machineId}/${reference.source.kind}`;
      if (locations.has(key)) throw new InvalidResponse();
      locations.add(key); return {...reference, snapshotId: row.snapshotId};
    });
    return {state: 'proposed', resourceId: value.resourceId, expectedRevision: value.expectedRevision, ownerId: value.ownerId,
      readers: [...value.readers], accountMapping, snapshots, planId: value.planId};
  } catch {throw new InvalidResponse();}
}

/** null means no receipt observed yet, not proof that an in-flight write failed. */
export function parseImportReceiptResult(value) {
  if (value === null) return null;
  if (!exact(value, ['requestId', 'resourceId', 'state', 'aclRevision']) || !uuid(value.requestId) || !id(value.resourceId)
    || value.state !== 'imported' || !Number.isSafeInteger(value.aclRevision) || value.aclRevision < 1) throw new InvalidResponse();
  return {requestId: value.requestId, resourceId: value.resourceId, state: 'imported', aclRevision: value.aclRevision};
}
