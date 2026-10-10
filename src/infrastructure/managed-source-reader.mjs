import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {ApplicationError} from '../domain/errors.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./legacy-cache-reader.py', import.meta.url));

/** Node-local adapter. The caller never supplies a root, interpreter or admin flag. */
export class ManagedSourceReader {
  #roots = new Map();
  constructor({machineId, roots, python = 'python3', timeoutMs = 5000}) {
    if (typeof machineId !== 'string' || !machineId || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid managed reader configuration');
    for (const {kind, root, mountPoint = null} of roots) {
      if (!['cache', 'warehouse'].includes(kind) || this.#roots.has(kind) || typeof root !== 'string' || !isAbsolute(root)
        || (mountPoint !== null && (typeof mountPoint !== 'string' || !isAbsolute(mountPoint)))) throw new TypeError('Invalid managed root configuration');
      this.#roots.set(kind, {kind, root, mountPoint});
    }
    this.machineId = machineId;
    this.python = python;
    this.timeoutMs = timeoutMs;
  }

  async inspect(request, {actor} = {}) {
    if (request.machineId !== this.machineId) throw new ApplicationError('SOURCE_NODE_MISMATCH');
    if (!actor?.id) throw new ApplicationError('UNAUTHENTICATED');
    const source = request.source, config = this.#roots.get(source.kind);
    if (!config) throw new ApplicationError('SOURCE_UNAVAILABLE');
    try {
      const running = run(this.python, ['-B', script], {encoding: 'utf8', timeout: this.timeoutMs, maxBuffer: 8192});
      let inputError;
      running.child.stdin.once('error', error => {inputError = error;});
      running.child.stdin.end(JSON.stringify({config, request: {
        userId: actor.id, dataset: source.datasetId, version: source.version, kind: source.kind,
      }}));
      const {stdout} = await running;
      if (inputError) throw inputError;
      const result = JSON.parse(stdout).result;
      if (result?.dataset !== source.datasetId || result?.version !== source.version || result?.kind !== source.kind) throw new Error('Managed source identity mismatch');
      if (result.availability === 'available' && Object.keys(result).length === 4) return {availability: 'available'};
      if (result.availability === 'unavailable' && result.reason === 'not-ready' && Object.keys(result).length === 5) return {availability: 'unavailable', reason: 'not-ready'};
      throw new Error('Invalid managed observation');
    } catch (cause) {
      let code;
      try {code = JSON.parse(cause.stdout).error?.code;} catch {}
      if (code === 'FORBIDDEN') throw new ApplicationError('FORBIDDEN');
      throw new ApplicationError('SOURCE_UNAVAILABLE', {cause});
    }
  }
}
