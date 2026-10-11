import {NodeJsonTransport} from './node-json-transport.mjs';
import {EXPANSION_RECEIPT_ROUTE, parseExpansionReceiptRequest, parseExpansionReceipt} from '../contracts/expansion-receipt.mjs';
import {ApplicationError} from '../domain/errors.mjs';

export class HttpExpansionReceipts {
  constructor(options) {this.transport = new NodeJsonTransport(options);}
  async lookup(request) {
    const input = parseExpansionReceiptRequest(request);
    try {
      const result = parseExpansionReceipt(await this.transport.request(input.machineId, EXPANSION_RECEIPT_ROUTE, input));
      if (result !== null && (result.machineId !== input.machineId || result.changeId !== input.changeId)) throw new Error('Expansion receipt identity mismatch');
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('EXPANSION_NODE_UNAVAILABLE', {cause});
    }
  }
}
