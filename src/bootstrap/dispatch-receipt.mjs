import {LookupNodeDispatch} from '../application/lookup-node-dispatch.mjs';
import {SqliteNodeDispatchBindings} from '../infrastructure/sqlite/node-dispatch-bindings.mjs';
import {GpuqReceiptReader} from '../infrastructure/gpuq-receipt-reader.mjs';
import {createDispatchReceiptHandler} from '../api/dispatch-receipt-handler.mjs';
import {LookupNodeExpansion} from '../application/lookup-node-expansion.mjs';
import {SqliteNodeExpansionBindings} from '../infrastructure/sqlite/node-expansion-bindings.mjs';

/** Node-local assembly; database schema and server lifecycle belong to the caller. */
export function assembleDispatchReceipt({database, machineId, credential, socketPath, python, timeoutMs, reportError}) {
  const native = new GpuqReceiptReader({socketPath, python, timeoutMs});
  const lookup = new LookupNodeDispatch({bindings: new SqliteNodeDispatchBindings({database, machineId}), native});
  const expansionLookup = new LookupNodeExpansion({bindings: new SqliteNodeExpansionBindings({database, machineId}), native});
  return createDispatchReceiptHandler({machineId, credential, lookup, expansionLookup, reportError});
}
