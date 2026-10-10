import {GPU_POOL_ROUTE, parseGpuPoolRequest, parseGpuPoolObservation} from '../contracts/gpu-pool.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {createJsonRoutes} from './json-http.mjs';

export function createGpuPoolHandler({machineId, credential, pools, reportError}) {
  const inspect = {async execute(_actor, input) {
    if (input.machineId !== machineId) throw new ApplicationError('GPU_POOL_NODE_MISMATCH');
    const result = parseGpuPoolObservation(await pools.inspect(input));
    if (result.machineId !== machineId) throw new ApplicationError('GPU_POOL_UNAVAILABLE');
    return result;
  }};
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([[GPU_POOL_ROUTE, {parse: parseGpuPoolRequest, useCase: inspect}]]),
    statuses: {UNAUTHENTICATED: 401, GPU_POOL_NODE_MISMATCH: 409, GPU_POOL_UNAVAILABLE: 503},
  });
}
