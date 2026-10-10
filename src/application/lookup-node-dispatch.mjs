import {nativeDispatchAcceptance} from '../domain/node-dispatch.mjs';

/** Lookup is observation only; no binding creation, native submit or fallback scan. */
export class LookupNodeDispatch {
  constructor({bindings, native}) {this.bindings = bindings; this.native = native;}
  async execute(reference) {
    const binding = await this.bindings.get(reference);
    if (!binding) return null;
    const receipt = await this.native.lookup({submitKey: binding.dispatchId});
    return receipt === null ? null : nativeDispatchAcceptance(binding, receipt);
  }
}
