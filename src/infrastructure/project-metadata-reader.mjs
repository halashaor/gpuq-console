import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {jsonProcess} from './json-process.mjs';
import {parseProjectInspection, parseProjectReference, parseProjectObservation} from '../contracts/project-inspection.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const script = fileURLToPath(new URL('./legacy-project-reader.py', import.meta.url));

export class ProjectMetadataReader {
  constructor({machineId, root, basePath, python = 'python3', timeoutMs = 5000}) {
    if (typeof root !== 'string' || !isAbsolute(root) || typeof basePath !== 'string' || !isAbsolute(basePath)) throw new TypeError('Invalid configured project roots');
    this.machineId = machineId; this.root = root; this.basePath = basePath; this.python = python; this.timeoutMs = timeoutMs;
  }
  async inspect(request, {actor} = {}) {
    const input = parseProjectInspection({...parseProjectReference(request), accountId: actor?.id});
    if (input.machineId !== this.machineId) throw new ApplicationError('PROJECT_NODE_MISMATCH');
    try {
      const {result} = await jsonProcess({program: this.python, args: ['-B', script], timeoutMs: this.timeoutMs,
        input: {config: {root: this.root, basePath: this.basePath}, request: {accountId: input.accountId, project: input.project, release: input.release}}});
      const observation = parseProjectObservation({...result, machineId: this.machineId});
      if (observation.accountId !== input.accountId || observation.project !== input.project || observation.release !== input.release) throw new Error('Project observation identity mismatch');
      return observation;
    } catch (cause) {throw new ApplicationError('PROJECT_SOURCE_UNAVAILABLE', {cause});}
  }
}
