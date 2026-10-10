import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./gpuq-pool.py', import.meta.url));
function gpuList(value) {
  return Array.isArray(value) && value.length <= 4096
    && value.every(id => typeof id === 'string' && /^GPU-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id))
    && new Set(value).size === value.length;
}

/** Point-in-time native pool observation, not a reservation or user quota. */
export class GpuqPoolReader {
  constructor({machineId, socketPath, python = 'python3', timeoutMs = 5000}) {
    if (typeof machineId !== 'string' || !machineId || typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new TypeError('Invalid configured GPUQ pool');
    this.machineId = machineId; this.socketPath = socketPath; this.python = python; this.timeoutMs = timeoutMs;
  }

  async inspect({machineId}) {
    if (machineId !== this.machineId) throw new ApplicationError('GPU_POOL_NODE_MISMATCH');
    try {
      const {result} = await jsonProcess({program: this.python, args: ['-B', script],
        input: {socketPath: this.socketPath}, timeoutMs: this.timeoutMs, maxBytes: 2 * 1024 * 1024});
      if (!result || typeof result.bootId !== 'string' || !result.bootId
        || typeof result.health !== 'string' || !result.health
        || typeof result.observeOnly !== 'boolean' || typeof result.releaseGateOpen !== 'boolean'
        || !gpuList(result.gpuUuids) || !gpuList(result.freeGpuUuids)
        || result.freeGpuUuids.some(id => !result.gpuUuids.includes(id))) throw new Error('Invalid native GPU pool');
      const dispatchEnabled = result.health === 'ok' && !result.observeOnly && result.releaseGateOpen;
      return {machineId, bootId: result.bootId, health: result.health, dispatchEnabled,
        gpuUuids: [...result.gpuUuids], freeGpuUuids: dispatchEnabled ? [...result.freeGpuUuids] : []};
    } catch (cause) {throw new ApplicationError('GPU_POOL_UNAVAILABLE', {cause});}
  }
}
