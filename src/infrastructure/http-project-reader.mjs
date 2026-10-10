import {NodeJsonTransport} from './node-json-transport.mjs';
import {PROJECT_INSPECTION_ROUTE, parseProjectReference, parseProjectInspection, parseProjectObservation} from '../contracts/project-inspection.mjs';
import {ApplicationError} from '../domain/errors.mjs';

export class HttpProjectReader {
  constructor(options) {this.transport = new NodeJsonTransport(options);}
  async inspect(request, {actor} = {}) {
    const input = parseProjectInspection({...parseProjectReference(request), accountId: actor?.id});
    try {
      const result = parseProjectObservation(await this.transport.request(input.machineId, PROJECT_INSPECTION_ROUTE, input));
      if (result.accountId !== input.accountId || result.machineId !== input.machineId || result.project !== input.project || result.release !== input.release) {
        throw new Error('Project observation identity mismatch');
      }
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('PROJECT_NODE_UNAVAILABLE', {cause});
    }
  }
}
