import {ApplicationError} from './errors.mjs';

export function requireProjectObservation(actor, request, observed) {
  if (!observed || observed.accountId !== actor.id || observed.machineId !== request.machineId
    || observed.project !== request.project || observed.release !== request.release
    || typeof observed.project !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(observed.project)
    || typeof observed.release !== 'string' || !/^[a-f0-9]{64}$/.test(observed.release)
    || typeof observed.projectUUID !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(observed.projectUUID)
    || typeof observed.generation !== 'string' || !/^[a-f0-9]{64}$/.test(observed.generation)
    || !['shared', 'isolated', 'oci'].includes(observed.environmentMode) || observed.runtimeVerified !== false) {
    throw new ApplicationError('PROJECT_OBSERVATION_INVALID');
  }
  if (observed.lifecycle !== 'ACTIVE') throw new ApplicationError('PROJECT_NOT_ACTIVE');
}
