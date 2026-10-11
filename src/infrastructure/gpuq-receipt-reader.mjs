import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jsonProcess} from './json-process.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./gpuq-submission-receipt.py', import.meta.url));

export class GpuqReceiptReader {
  constructor({socketPath, python = 'python3', timeoutMs = 5000}) {
    if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new TypeError('Invalid GPUQ socket');
    this.socketPath = socketPath; this.python = python; this.timeoutMs = timeoutMs;
  }
  lookup({submitKey}) {return this.#query(submitKey);}
  lookupScale({submitKey, planId}) {
    if (typeof planId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(planId)) throw new ApplicationError('INVALID_NATIVE_PLAN_ID');
    return this.#query(submitKey, planId);
  }
  async #query(submitKey, planId) {
    if (typeof submitKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(submitKey)) {
      throw new ApplicationError('INVALID_NATIVE_SUBMIT_KEY');
    }
    try {
      const response = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: this.timeoutMs,
        input: {socketPath: this.socketPath, submitKey, ...(planId === undefined ? {} : {planId})}});
      if (!response || !Object.hasOwn(response, 'result')) throw new Error('Missing native receipt result');
      return response.result;
    } catch (cause) {throw new ApplicationError('GPUQ_RECEIPT_UNAVAILABLE', {cause});}
  }
}
