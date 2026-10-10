import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ApplicationError} from '../domain/errors.mjs';

const run = promisify(execFile);
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

  async #evaluate(operation, args) {
    try {
      const running = run(this.python, ['-B', script], {encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 65536});
      let inputError;
      running.child.stdin.once('error', error => {inputError = error;});
      running.child.stdin.end(JSON.stringify({operation, args}));
      const {stdout} = await running;
      if (inputError) throw inputError;
      const response = JSON.parse(stdout);
      if (!response || !Object.hasOwn(response, 'result')) throw new Error('Missing policy result');
      return response.result;
    } catch (cause) {
      let code;
      try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      throw new ApplicationError(code === 'INVALID_SCHEDULING_REQUEST' ? code : 'SCHEDULING_POLICY_UNAVAILABLE', {cause});
    }
  }
}
