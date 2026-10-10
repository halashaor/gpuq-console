import {ApplicationError} from '../domain/errors.mjs';

/** Query original dispatch only: no resend, failover, quota release or training completion claim. */
export class ReconcileTrainingDispatch {
  constructor({dispatches, nodes}) {this.dispatches = dispatches; this.nodes = nodes;}

  async execute(dispatchId) {
    const dispatch = await this.dispatches.delivery(dispatchId);
    if (!dispatch) throw new ApplicationError('TRAINING_DISPATCH_NOT_FOUND');
    if (dispatch.state === 'PREPARED') return {kind: 'not-sent', dispatch};
    if (dispatch.state === 'ACCEPTED') return {kind: 'accepted', dispatch};
    const observed = await this.nodes.lookup({machineId: dispatch.machineId, dispatchId});
    // No record observed is not proof that the original send never arrived.
    if (observed === null) {
      const current = await this.dispatches.delivery(dispatchId);
      if (!current) throw new ApplicationError('TRAINING_DISPATCH_NOT_FOUND');
      return {kind: current.state === 'ACCEPTED' ? 'accepted' : 'unconfirmed', dispatch: current};
    }
    // Bind the lookup target before handing evidence to storage. Never let a
    // response from this node update another dispatch record.
    if (observed?.dispatchId !== dispatchId || observed.machineId !== dispatch.machineId) {
      throw new ApplicationError('DISPATCH_OBSERVATION_MISMATCH');
    }
    await this.dispatches.confirmAcceptance(observed);
    return {kind: 'accepted', dispatch: await this.dispatches.delivery(dispatchId)};
  }
}
