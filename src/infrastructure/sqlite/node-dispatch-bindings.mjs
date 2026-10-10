import {transaction, readTransaction} from './transaction.mjs';
import {nodeDispatchBinding} from '../../domain/node-dispatch.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export function createNodeDispatchBindingsSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_node_dispatch_bindings (
    dispatch_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL
  )`));
}

/** Node-local immutable mapping, written by the trusted launch builder, not public input. */
export class SqliteNodeDispatchBindings {
  constructor({database, machineId}) {this.database = database; this.machineId = machineId;}
  #read(dispatchId) {
    const row = this.database.prepare('SELECT binding_json FROM v2_node_dispatch_bindings WHERE dispatch_id=?').get(dispatchId);
    if (!row) return null;
    const binding = nodeDispatchBinding(JSON.parse(row.binding_json));
    if (binding.machineId !== this.machineId || binding.dispatchId !== dispatchId) throw new ApplicationError('NODE_DISPATCH_BINDING_CONFLICT');
    return binding;
  }
  bind(input) {
    const binding = nodeDispatchBinding(input);
    if (binding.machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return transaction(this.database, () => {
      const existing = this.#read(binding.dispatchId), payload = JSON.stringify(binding);
      if (existing) {
        if (JSON.stringify(existing) !== payload) throw new ApplicationError('NODE_DISPATCH_BINDING_CONFLICT');
        return existing;
      }
      this.database.prepare('INSERT INTO v2_node_dispatch_bindings VALUES(?,?)').run(binding.dispatchId, payload);
      return binding;
    });
  }
  get({machineId, dispatchId}) {
    if (machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return readTransaction(this.database, () => this.#read(dispatchId));
  }
}
