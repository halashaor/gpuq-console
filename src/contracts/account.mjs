import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const ACCOUNT_CHANGE_ROUTE = '/api/v2/accounts/change';
export const ACCOUNT_GET_ROUTE = '/api/v2/accounts/get';
export const PASSWORD_RESET_ROUTE = '/api/v2/accounts/reset-password';
export const ACCOUNT_CREATE_ROUTE = '/api/v2/accounts/create';

function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new InvalidRequest('password');
  return value;
}

/** The caller keeps this new UUID to query the same account after receipt loss. */
export function parseAccountCreate(value) {
  const fields = ['accountId', 'username', 'displayName', 'role', 'password'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || !fields.every(key => Object.hasOwn(value, key))) throw new InvalidRequest('request');
  if (typeof value.accountId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.accountId)) throw new InvalidRequest('accountId');
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  if (!/^[a-z\u3400-\u9fff][a-z0-9_\u3400-\u9fff-]{1,23}$/u.test(username) || username === 'admin') throw new InvalidRequest('username');
  if (typeof value.displayName !== 'string' || !value.displayName.isWellFormed()) throw new InvalidRequest('displayName');
  const displayName = value.displayName.trim();
  if (!displayName || [...displayName].length > 32 || new TextEncoder().encode(displayName).length > 128
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(displayName)) throw new InvalidRequest('displayName');
  if (!['member', 'admin'].includes(value.role)) throw new InvalidRequest('role');
  return {accountId: value.accountId, username, displayName, role: value.role, password: newPassword(value.password)};
}

export function parsePasswordReset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['accountId', 'revision', 'password'].every(key => Object.hasOwn(value, key))) throw new InvalidRequest('request');
  const {accountId} = parseAccountQuery({accountId: value.accountId});
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new InvalidRequest('revision');
  return {accountId, revision: value.revision, password: newPassword(value.password)};
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
