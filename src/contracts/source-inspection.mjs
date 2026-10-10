import {parseDataReadRequest} from './data-read.mjs';
import {InvalidRequest} from './errors.mjs';

export const SOURCE_INSPECTION_ROUTE = '/internal/v2/source/inspect';

/** Only the authenticated coordinator supplies this identity, not a user API. */
export function parseSourceInspection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'accountId') || !Object.hasOwn(value, 'request')) throw new InvalidRequest('request');
  if (typeof value.accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.accountId)) throw new InvalidRequest('accountId');
  return {accountId: value.accountId, request: parseDataReadRequest(value.request)};
}
