import {NodeJsonTransport} from './node-json-transport.mjs';
import {DISPATCH_RECEIPT_ROUTE, parseDispatchReceiptRequest, parseDispatchReceipt} from '../contracts/dispatch-receipt.mjs';
import {ApplicationError} from '../domain/errors.mjs';

export class HttpDispatchReceipts {
  constructor(options) {this.transport = new NodeJsonTransport(options);}
  async lookup(request) {
    const input = parseDispatchReceiptRequest(request);
    try {
      const result = parseDispatchReceipt(await this.transport.request(input.machineId, DISPATCH_RECEIPT_ROUTE, input));
      if (result !== null && (result.machineId !== input.machineId || result.dispatchId !== input.dispatchId)) {
        throw new Error('Dispatch receipt identity mismatch');
      }
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('DISPATCH_NODE_UNAVAILABLE', {cause});
    }
  }
}
