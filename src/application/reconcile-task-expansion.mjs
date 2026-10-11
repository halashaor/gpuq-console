import {requireExpansionIdentity} from '../domain/expansion-confirmation.mjs';
import {ApplicationError} from '../domain/errors.mjs';

export class ReconcileTaskExpansion {
  constructor({claims, nodes}) {this.claims = claims; this.nodes = nodes;}
  async execute(changeId) {
    const expansion = await this.claims.expansion(changeId);
    if (!expansion) throw new ApplicationError('COMPUTE_EXPANSION_NOT_FOUND');
    if (expansion.state !== 'RESERVED') return {kind: expansion.state.toLowerCase(), expansion};
    const observed = await this.nodes.lookup({machineId: expansion.machineId, changeId});
    if (observed !== null) {
      requireExpansionIdentity(expansion, observed);
      if (observed.planState === 'COMPLETED') {
        return {kind: 'applied', expansion: await this.claims.confirmExpansionApplied(observed)};
      }
    }
    // Failure, cancellation and empty lookup are not resource-release proofs.
    const current = await this.claims.expansion(changeId);
    if (!current) throw new ApplicationError('COMPUTE_EXPANSION_NOT_FOUND');
    return {kind: current.state === 'RESERVED' ? 'unconfirmed' : current.state.toLowerCase(), expansion: current};
  }
}
