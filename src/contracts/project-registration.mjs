import {parseProjectReference} from './project-inspection.mjs';
import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const PROJECT_REGISTRATION_ROUTES = {register: '/api/v2/projects/register-release', get: '/api/v2/projects/registration'};
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));

export function parseProjectRegistration(value) {
  if (!exact(value, ['projectId', 'machineId', 'project', 'release']) || !id(value.projectId)) throw new InvalidRequest('request');
  return {projectId: value.projectId, ...parseProjectReference({machineId: value.machineId, project: value.project, release: value.release})};
}

/** A stored registration is not a fresh node observation or runtime lease. */
export function parseProjectRegistrationResult(value) {
  if (value === null) return null;
  if (!exact(value, ['projectId', 'machineId', 'release', 'projectUUID', 'generation', 'registered', 'runtimeVerified'])
    || !id(value.projectId) || !id(value.machineId) || !hash(value.release) || !hash(value.generation)
    || typeof value.projectUUID !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.projectUUID)
    || value.registered !== true || value.runtimeVerified !== false) throw new InvalidResponse();
  return {projectId: value.projectId, machineId: value.machineId, release: value.release,
    projectUUID: value.projectUUID, generation: value.generation, registered: true, runtimeVerified: false};
}
