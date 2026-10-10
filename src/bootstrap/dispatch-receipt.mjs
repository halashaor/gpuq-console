import {LookupNodeDispatch} from '../application/lookup-node-dispatch.mjs';
import {SqliteNodeDispatchBindings} from '../infrastructure/sqlite/node-dispatch-bindings.mjs';
import {GpuqReceiptReader} from '../infrastructure/gpuq-receipt-reader.mjs';
import {createDispatchReceiptHandler} from '../api/dispatch-receipt-handler.mjs';

/** Node-local assembly; database schema and server lifecycle belong to the caller. */
export function assembleDispatchReceipt({database, machineId, credential, socketPath, python, timeoutMs, reportError}) {
  const lookup = new LookupNodeDispatch({bindings: new SqliteNodeDispatchBindings({database, machineId}),
    native: new GpuqReceiptReader({socketPath, python, timeoutMs})});
  return createDispatchReceiptHandler({machineId, credential, lookup, reportError});
}
