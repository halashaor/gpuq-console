import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const COMPUTE_POLICY_ROUTES = {get: '/api/v2/compute-policy/get', set: '/api/v2/compute-policy/set'};
export function parseComputePolicyQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 128) throw new InvalidRequest('accountId');
  return {accountId: value.accountId};
}

export function parseComputePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
    || !['accountId', 'revision', 'totalCards', 'limits'].every(key => Object.hasOwn(value, key))) throw new InvalidRequest('request');
  const {accountId} = parseComputePolicyQuery({accountId: value.accountId});
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new InvalidRequest('revision');
  if (!Number.isSafeInteger(value.totalCards) || value.totalCards < 0) throw new InvalidRequest('totalCards');
  if (!Array.isArray(value.limits) || value.limits.length > 100) throw new InvalidRequest('limits');
  const ids = new Set();
  const limits = value.limits.map(limit => {
    if (!limit || typeof limit !== 'object' || Array.isArray(limit) || Object.keys(limit).length !== 2
      || typeof limit.machineId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(limit.machineId)
      || !Number.isSafeInteger(limit.maxCards) || limit.maxCards < 1 || ids.has(limit.machineId)) throw new InvalidRequest('limits');
    ids.add(limit.machineId);
    return {machineId: limit.machineId, maxCards: limit.maxCards};
  });
  return {accountId, revision: value.revision, totalCards: value.totalCards, limits};
}

export function parseComputePolicyResult(value) {
  try {return parseComputePolicy(value);}
  catch {throw new InvalidResponse();}
}
