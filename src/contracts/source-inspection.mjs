import {parseDataReadRequest} from './data-read.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const SOURCE_INSPECTION_ROUTE = '/internal/v2/source/inspect';
export const SOURCE_ACCESS_ROUTE = '/internal/v2/source/access-snapshot';

export function parseSourceAccessRequest(value) {
  const input = parseSourceInspection(value);
  if (input.request.source.kind === 'directory') throw new InvalidRequest('source.kind');
  return input;
}

export function parseSourceAccessResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
      || !Array.isArray(value.legacyOwners) || !value.legacyOwners.length || value.legacyOwners.length > 10000
      || !value.legacyOwners.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(id))
      || new Set(value.legacyOwners).size !== value.legacyOwners.length
      || typeof value.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotId)) throw new InvalidResponse();
    const request = parseDataReadRequest({machineId: value.machineId, source: value.source});
    if (request.source.kind === 'directory') throw new InvalidResponse();
    return {...request, legacyOwners: [...value.legacyOwners], snapshotId: value.snapshotId};
  } catch {throw new InvalidResponse();}
}

/** Only the authenticated coordinator supplies this identity, not a user API. */
export function parseSourceInspection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'accountId') || !Object.hasOwn(value, 'request')) throw new InvalidRequest('request');
  if (typeof value.accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.accountId)) throw new InvalidRequest('accountId');
  return {accountId: value.accountId, request: parseDataReadRequest(value.request)};
}
