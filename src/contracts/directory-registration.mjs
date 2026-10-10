import {parseDataReadRequest} from './data-read.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const REGISTER_DIRECTORY_ROUTE = '/api/v2/data/register-directory';

export function parseDirectoryRegistration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'machineId') || !Object.hasOwn(value, 'sourceId')) throw new InvalidRequest('request');
  const parsed = parseDataReadRequest({machineId: value.machineId, source: {kind: 'directory', sourceId: value.sourceId}});
  return {machineId: parsed.machineId, sourceId: parsed.source.sourceId};
}

export function parseDirectoryRegistrationResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4
      || typeof value.resourceId !== 'string' || !value.resourceId || value.resourceId.length > 128
      || value.registered !== true) throw new InvalidResponse();
    const request = parseDirectoryRegistration({machineId: value.machineId, sourceId: value.sourceId});
    return {...request, resourceId: value.resourceId, registered: true};
  } catch {throw new InvalidResponse();}
}
