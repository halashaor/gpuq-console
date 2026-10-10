import {ApplicationError} from './errors.mjs';

function requireProjectIdentity(actor, request, observed) {
  if (!observed || observed.accountId !== actor.id || observed.machineId !== request.machineId
    || observed.project !== request.project || observed.release !== request.release
    || typeof observed.project !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(observed.project)
    || typeof observed.release !== 'string' || !/^[a-f0-9]{64}$/.test(observed.release)
    || typeof observed.projectUUID !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(observed.projectUUID)
    || typeof observed.generation !== 'string' || !/^[a-f0-9]{64}$/.test(observed.generation)
    || !['shared', 'isolated', 'oci'].includes(observed.environmentMode)) {
    throw new ApplicationError('PROJECT_OBSERVATION_INVALID');
  }
  if (observed.lifecycle !== 'ACTIVE') throw new ApplicationError('PROJECT_NOT_ACTIVE');
}

export function requireProjectObservation(actor, request, observed) {
  requireProjectIdentity(actor, request, observed);
  if (observed.runtimeVerified !== false) throw new ApplicationError('PROJECT_OBSERVATION_INVALID');
}

export function requireProjectRuntimeObservation(actor, request, observed) {
  requireProjectIdentity(actor, request, observed);
  const oci = observed.environmentMode === 'oci';
  if (observed.runtimeIdentityVerified !== true || observed.runtime?.kind !== (oci ? 'oci' : 'base')
    || typeof observed.runtime.identity !== 'string'
    || !(oci ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(observed.runtime.identity)) {
    throw new ApplicationError('PROJECT_OBSERVATION_INVALID');
  }
}
