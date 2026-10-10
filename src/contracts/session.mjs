import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const SESSION_ROUTES = {
  login: '/api/v2/session/login',
  refresh: '/api/v2/session/refresh',
  logout: '/api/v2/session/logout',
};

function exactFields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

export function parseLoginRequest(value) {
  if (!exactFields(value, ['username', 'password', 'delivery'])) throw new InvalidRequest('request');
  const {username, password, delivery} = value;
  if (typeof username !== 'string' || !username.trim() || username.length > 128) throw new InvalidRequest('username');
  if (typeof password !== 'string' || !password.length || password.length > 1024) throw new InvalidRequest('password');
  if (!['cookie', 'token'].includes(delivery)) throw new InvalidRequest('delivery');
  return {username: username.trim(), password, delivery};
}

export function parseEmptyRequest(value) {
  if (!exactFields(value, [])) throw new InvalidRequest('request');
}

export function parseExpiryResult(value) {
  if (!exactFields(value, ['expiresAtMs']) || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= 0) {
    throw new InvalidResponse();
  }
  return {expiresAtMs: value.expiresAtMs};
}

export function parseLoginResult(value, delivery) {
  if (!exactFields(value, delivery === 'token' ? ['account', 'expiresAtMs', 'credential'] : ['account', 'expiresAtMs'])) {
    throw new InvalidResponse();
  }
  const {account} = value;
  if (!exactFields(account, ['id', 'username', 'displayName', 'role'])
    || !['id', 'username', 'displayName'].every(key => typeof account[key] === 'string' && account[key].length > 0)
    || !['admin', 'member'].includes(account.role)) throw new InvalidResponse();
  const expiry = parseExpiryResult({expiresAtMs: value.expiresAtMs});
  if (delivery === 'token' && !/^[a-f0-9]{64}$/.test(value.credential)) throw new InvalidResponse();
  return {...expiry, account: {...account}, ...(delivery === 'token' ? {credential: value.credential} : {})};
}

export function parseLogoutResult(value) {
  if (!exactFields(value, ['revoked']) || value.revoked !== true) throw new InvalidResponse();
  return {revoked: true};
}
