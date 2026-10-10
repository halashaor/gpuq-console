import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const DATA_ACCESS_ROUTES = {get: '/api/v2/data-access/get', set: '/api/v2/data-access/set-readers'};
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function parseDataAccessQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !identifier(value.resourceId)) throw new InvalidRequest('resourceId');
  return {resourceId: value.resourceId};
}

export function parseDataReaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['resourceId', 'revision', 'readers'].every(key => Object.hasOwn(value, key))) throw new InvalidRequest('request');
  const {resourceId} = parseDataAccessQuery({resourceId: value.resourceId});
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new InvalidRequest('revision');
  if (!Array.isArray(value.readers) || value.readers.length > 100 || !value.readers.every(identifier)
    || new Set(value.readers).size !== value.readers.length) throw new InvalidRequest('readers');
  return {resourceId, revision: value.revision, readers: [...value.readers]};
}

export function parseDataAccessResult(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5
      || !['private', 'shared'].includes(value.visibility) || (value.ownerId !== null && !identifier(value.ownerId))) throw new InvalidResponse();
    const access = parseDataReaders({resourceId: value.resourceId, revision: value.revision, readers: value.readers});
    return {...access, visibility: value.visibility, ownerId: value.ownerId};
  } catch {throw new InvalidResponse();}
}
