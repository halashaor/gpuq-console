import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const GPU_POOL_ROUTE = '/internal/v2/gpu/pool';
export const GPU_POOL_MAX_BYTES = 2 * 1024 * 1024;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

export function parseGpuPoolRequest(value) {
  if (!exact(value, ['machineId']) || typeof value.machineId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.machineId)) throw new InvalidRequest('machineId');
  return {machineId: value.machineId};
}

export function isGpuUuidList(value) {
  return Array.isArray(value) && value.length <= 4096
    && value.every(id => typeof id === 'string' && /^GPU-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id))
    && new Set(value).size === value.length;
}

export function parseGpuPoolObservation(value) {
  try {
    if (!exact(value, ['machineId', 'bootId', 'health', 'dispatchEnabled', 'gpuUuids', 'freeGpuUuids'])
      || typeof value.bootId !== 'string' || !value.bootId || value.bootId.length > 128
      || typeof value.health !== 'string' || !value.health || value.health.length > 64
      || typeof value.dispatchEnabled !== 'boolean'
      || !isGpuUuidList(value.gpuUuids) || !isGpuUuidList(value.freeGpuUuids)
      || value.freeGpuUuids.some(id => !value.gpuUuids.includes(id))
      || (value.dispatchEnabled && value.health !== 'ok')
      || (!value.dispatchEnabled && value.freeGpuUuids.length)) throw new InvalidResponse();
    return {...parseGpuPoolRequest({machineId: value.machineId}), bootId: value.bootId, health: value.health,
      dispatchEnabled: value.dispatchEnabled, gpuUuids: [...value.gpuUuids], freeGpuUuids: [...value.freeGpuUuids]};
  } catch {throw new InvalidResponse();}
}
