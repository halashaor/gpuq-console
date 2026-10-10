import {parseDataReadRequest} from './data-read.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const REGISTER_MANAGED_SOURCE_ROUTE = '/api/v2/data/register-managed';
export function parseManagedRegistration(value) {
  const request = parseDataReadRequest(value);
  if (request.source.kind === 'directory') throw new InvalidRequest('source.kind');
  return request;
}
export function parseManagedRegistrationResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
      || typeof value.resourceId !== 'string' || !value.resourceId || value.resourceId.length > 128
      || value.registered !== true) throw new InvalidResponse();
    return {...parseManagedRegistration({machineId: value.machineId, source: value.source}), resourceId: value.resourceId, registered: true};
  } catch {throw new InvalidResponse();}
}
