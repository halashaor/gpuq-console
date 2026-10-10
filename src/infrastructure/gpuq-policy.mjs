import {jsonProcess} from './json-process.mjs';
import {fileURLToPath} from 'node:url';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./gpuq-policy.py', import.meta.url));

/** Reuses native pure policy. These results never reserve or release a GPU. */
export class GpuqPolicy {
  constructor({python = 'python3', timeoutMs = 5000} = {}) {
    this.python = python;
    this.timeoutMs = timeoutMs;
  }
  elastic(args) {return this.#evaluate('elastic', args);}
  preemption(args) {return this.#evaluate('preemption', args);}
  queue(args) {return this.#evaluate('queue', args);}
  resources(args) {return this.#evaluate('resources', args);}

  async #evaluate(operation, args) {
    try {
      const response = await jsonProcess({program: this.python, args: ['-B', script], input: {operation, args},
        timeoutMs: this.timeoutMs, maxBytes: 65536});
      if (!response || !Object.hasOwn(response, 'result')) throw new Error('Missing policy result');
      return response.result;
    } catch (cause) {
      let code;
      try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      if (cause.code === 'NATIVE_REQUEST_TOO_LARGE') code = 'INVALID_SCHEDULING_REQUEST';
      throw new ApplicationError(code === 'INVALID_SCHEDULING_REQUEST' ? code : 'SCHEDULING_POLICY_UNAVAILABLE', {cause});
    }
  }
}
