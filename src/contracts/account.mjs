import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const ACCOUNT_CHANGE_ROUTE = '/api/v2/accounts/change';
export const ACCOUNT_GET_ROUTE = '/api/v2/accounts/get';
export const PASSWORD_RESET_ROUTE = '/api/v2/accounts/reset-password';

export function parsePasswordReset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['accountId', 'revision', 'password'].every(key => Object.hasOwn(value, key))) throw new InvalidRequest('request');
  const {accountId} = parseAccountQuery({accountId: value.accountId});
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new InvalidRequest('revision');
  if (typeof value.password !== 'string' || value.password.length < 8 || value.password.length > 128) throw new InvalidRequest('password');
  return {accountId, revision: value.revision, password: value.password};
}

export function parseAccountQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 128) throw new InvalidRequest('accountId');
  return {accountId: value.accountId};
}

export function parseAccountChange(value) {
  const fields = value?.kind === 'role' ? ['accountId', 'revision', 'kind', 'role'] : ['accountId', 'revision', 'kind', 'enabled'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new InvalidRequest('request');
  if (typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 128) throw new InvalidRequest('accountId');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new InvalidRequest('revision');
  if (value.kind === 'role' && ['member', 'admin'].includes(value.role)) return {...value};
  if (value.kind === 'enabled' && typeof value.enabled === 'boolean') return {...value};
  throw new InvalidRequest('change');
}

export function parseAccountResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || typeof value.id !== 'string' || !value.id
    || !['member', 'admin'].includes(value.role) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new InvalidResponse();
  return {id: value.id, role: value.role, enabled: value.enabled, revision: value.revision};
}
