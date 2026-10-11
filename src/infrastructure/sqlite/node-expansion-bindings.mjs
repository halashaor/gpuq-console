import {transaction, readTransaction} from './transaction.mjs';
import {nodeDispatchBinding} from '../../domain/node-dispatch.mjs';
import {nodeExpansionBinding} from '../../domain/node-expansion.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export function createNodeExpansionBindingsSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_node_expansion_bindings (
    change_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL REFERENCES v2_node_dispatch_bindings(dispatch_id),
    plan_id TEXT NOT NULL, binding_json TEXT NOT NULL, UNIQUE(dispatch_id,plan_id)
  )`));
}

/** Fixed node plan association; querying never discovers/adopts the latest plan. */
export class SqliteNodeExpansionBindings {
  constructor({database, machineId}) {this.database = database; this.machineId = machineId;}
  #dispatch(dispatchId) {
    const row = this.database.prepare('SELECT binding_json FROM v2_node_dispatch_bindings WHERE dispatch_id=?').get(dispatchId);
    if (!row) throw new ApplicationError('NODE_DISPATCH_BINDING_MISSING');
    const value = nodeDispatchBinding(JSON.parse(row.binding_json));
    if (value.machineId !== this.machineId || value.dispatchId !== dispatchId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return value;
  }
  bind(input) {
    const binding = nodeExpansionBinding(input), payload = JSON.stringify(binding);
    return transaction(this.database, () => {
      const dispatch = this.#dispatch(binding.dispatchId);
      if (binding.targetGpuCount > dispatch.nativeMaxGpus) throw new ApplicationError('INVALID_NODE_EXPANSION_BINDING');
      const row = this.database.prepare('SELECT binding_json FROM v2_node_expansion_bindings WHERE change_id=?').get(binding.changeId);
      if (row) {
        if (row.binding_json !== payload) throw new ApplicationError('NODE_EXPANSION_BINDING_CONFLICT');
        return binding;
      }
      if (this.database.prepare('SELECT 1 FROM v2_node_expansion_bindings WHERE dispatch_id=? AND plan_id=?').get(binding.dispatchId, binding.planId)) {
        throw new ApplicationError('NODE_EXPANSION_BINDING_CONFLICT');
      }
      this.database.prepare('INSERT INTO v2_node_expansion_bindings VALUES(?,?,?,?)').run(binding.changeId, binding.dispatchId, binding.planId, payload);
      return binding;
    });
  }
  get({machineId, changeId}) {
    if (machineId !== this.machineId) throw new ApplicationError('NODE_DISPATCH_MACHINE_MISMATCH');
    return readTransaction(this.database, () => {
      const row = this.database.prepare('SELECT * FROM v2_node_expansion_bindings WHERE change_id=?').get(changeId);
      if (!row) return null;
      const expansion = nodeExpansionBinding(JSON.parse(row.binding_json));
      if (expansion.changeId !== changeId || expansion.dispatchId !== row.dispatch_id || expansion.planId !== row.plan_id) {
        throw new ApplicationError('NODE_EXPANSION_BINDING_CONFLICT');
      }
      return {dispatch: this.#dispatch(expansion.dispatchId), expansion};
    });
  }
}
