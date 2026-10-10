import {SOURCE_INSPECTION_ROUTE, SOURCE_ACCESS_ROUTE, parseSourceInspection, parseSourceAccessResult} from '../contracts/source-inspection.mjs';
import {parseDataReadResult} from '../contracts/data-read.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {NodeJsonTransport} from './node-json-transport.mjs';

/** Trusted node inventory is explicit; no discovery, failover or automatic retry. */
export class HttpSourceReader {
  constructor(options) {this.transport = new NodeJsonTransport(options);}

  async inspect(request, {actor} = {}) {
    const result = await this.#query(SOURCE_INSPECTION_ROUTE, request, actor, parseDataReadResult);
    return result.availability === 'available' ? {availability: 'available'} : {availability: result.availability, reason: result.reason};
  }

  async exportAccess(request, {actor} = {}) {
    return this.#query(SOURCE_ACCESS_ROUTE, request, actor, parseSourceAccessResult);
  }

  async #query(route, request, actor, decode) {
    const input = parseSourceInspection({request, accountId: actor?.id});
    try {
      const result = decode(await this.transport.request(request.machineId, route, input));
      if (result.machineId !== request.machineId || JSON.stringify(result.source) !== JSON.stringify(request.source)) {
        throw new Error('Node observation identity mismatch');
      }
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('SOURCE_NODE_UNAVAILABLE', {cause});
    }
  }
}
