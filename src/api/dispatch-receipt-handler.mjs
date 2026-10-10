import {DISPATCH_RECEIPT_ROUTE, parseDispatchReceiptRequest, parseDispatchReceipt} from '../contracts/dispatch-receipt.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {createJsonRoutes} from './json-http.mjs';

export function createDispatchReceiptHandler({machineId, credential, lookup, reportError}) {
  const read = {async execute(_actor, input) {
    if (input.machineId !== machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    const result = parseDispatchReceipt(await lookup.execute(input));
    if (result !== null && (result.machineId !== machineId || result.dispatchId !== input.dispatchId)) {
      throw new ApplicationError('NATIVE_DISPATCH_RECEIPT_MISMATCH');
    }
    return result;
  }};
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([[DISPATCH_RECEIPT_ROUTE, {parse: parseDispatchReceiptRequest, useCase: read}]]),
    statuses: {UNAUTHENTICATED: 401, NODE_DISPATCH_MACHINE_MISMATCH: 409, GPUQ_RECEIPT_UNAVAILABLE: 503,
      NATIVE_DISPATCH_RECEIPT_MISMATCH: 503, NODE_DISPATCH_BINDING_CONFLICT: 503},
  });
}
