import {GpuqPoolReader} from '../infrastructure/gpuq-pool-reader.mjs';
import {createGpuPoolHandler} from '../api/gpu-pool-handler.mjs';

export function assembleGpuPool({machineId, credential, socketPath, python, timeoutMs, reportError}) {
  return createGpuPoolHandler({machineId, credential, reportError,
    pools: new GpuqPoolReader({machineId, socketPath, python, timeoutMs})});
}
