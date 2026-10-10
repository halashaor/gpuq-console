import {NodeJsonTransport} from './node-json-transport.mjs';
import {GPU_POOL_ROUTE, GPU_POOL_MAX_BYTES, parseGpuPoolRequest, parseGpuPoolObservation} from '../contracts/gpu-pool.mjs';
import {ApplicationError} from '../domain/errors.mjs';

export class HttpGpuPoolReader {
  constructor(options) {this.transport = new NodeJsonTransport({...options, maxResponseBytes: GPU_POOL_MAX_BYTES});}
  async inspect(request) {
    const input = parseGpuPoolRequest(request);
    try {
      const result = parseGpuPoolObservation(await this.transport.request(input.machineId, GPU_POOL_ROUTE, input));
      if (result.machineId !== input.machineId) throw new Error('GPU pool node mismatch');
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('GPU_POOL_UNAVAILABLE', {cause});
    }
  }
}
