import {nativeExpansionObservation} from '../domain/node-expansion.mjs';

export class LookupNodeExpansion {
  constructor({bindings, native}) {this.bindings = bindings; this.native = native;}
  async execute(reference) {
    const binding = await this.bindings.get(reference);
    if (!binding) return null;
    const {dispatch, expansion} = binding;
    const receipt = await this.native.lookupScale({submitKey: dispatch.dispatchId, planId: expansion.planId});
    return receipt === null ? null : nativeExpansionObservation(dispatch, expansion, receipt);
  }
}
