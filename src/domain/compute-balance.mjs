import {ApplicationError} from './errors.mjs';

/** Quota claims, not physical GPU availability; reduced limits never erase holds. */
export function computeBalance({machineId, machine, admin, accountingReady, totalLimit, heldTotal, heldOnMachine}) {
  if (!machine || (!admin && !machine.granted)) throw new ApplicationError('FORBIDDEN');
  if (!machine.enabled) throw new ApplicationError('MACHINE_DISABLED');
  if (!accountingReady) throw new ApplicationError('COMPUTE_ACCOUNTING_UNREADY');
  if (machine.cards === null || (!admin && (machine.maxCards === null || totalLimit === null))) {
    throw new ApplicationError('COMPUTE_LIMITS_UNINITIALIZED');
  }
  const machineLimit = admin ? machine.cards : Math.min(machine.cards, machine.maxCards);
  return {machineId, machineLimit, totalLimit: admin ? null : totalLimit, heldOnMachine, heldTotal,
    remainingGpus: Math.max(0, Math.min(machineLimit - heldOnMachine, admin ? Infinity : totalLimit - heldTotal))};
}
