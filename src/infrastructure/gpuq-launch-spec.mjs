import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {isGpuUuidList} from '../contracts/gpu-pool.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./gpuq-launch-spec.py', import.meta.url));

/** Internal node builder only: normalized argv/env remain private execution material. */
export class GpuqLaunchSpec {
  constructor({python = 'python3', timeoutMs = 5000, maxRequestBytes = 262144} = {}) {
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new TypeError('Invalid native request limit');
    this.python = python; this.timeoutMs = timeoutMs; this.maxRequestBytes = maxRequestBytes;
  }
  async build(submission, {gpuUuids}) {
    if (!isGpuUuidList(gpuUuids) || !gpuUuids.length) throw new ApplicationError('GPU_INVENTORY_INVALID');
    try {
      const {result} = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: this.timeoutMs, maxBytes: 2 * 1024 * 1024,
        input: {submission, gpuUuids, maxRequestBytes: this.maxRequestBytes}});
      if (!result?.submission || typeof result.nativeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(result.nativeDigest)) throw new Error('Invalid native build result');
      return result;
    } catch (cause) {
      let code;
      try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      if (cause.code === 'NATIVE_REQUEST_TOO_LARGE') code = 'INVALID_NATIVE_SUBMISSION';
      throw new ApplicationError(code === 'INVALID_NATIVE_SUBMISSION' ? code : 'NATIVE_SUBMISSION_UNAVAILABLE', {cause});
    }
  }
}
