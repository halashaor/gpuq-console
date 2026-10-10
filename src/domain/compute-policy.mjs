import {ApplicationError} from './errors.mjs';
import {requireAccountRead} from './account-policy.mjs';

export function requireComputePolicyAccess(actor, facts, now) {
  requireAccountRead(actor, facts, now);
  if (facts.target.role === 'admin') throw new ApplicationError('ADMIN_POLICY_INHERITED');
}

export function requireComputePolicyChange(actor, facts, command, now) {
  requireComputePolicyAccess(actor, facts, now);
  if (facts.revision !== command.revision) throw new ApplicationError('POLICY_CHANGED');
  for (const limit of command.limits) {
    const machine = facts.machines.find(machine => machine.id === limit.machineId);
    if (!machine) throw new ApplicationError('MACHINE_NOT_FOUND');
    if (machine.cards === null) throw new ApplicationError('MACHINE_CAPACITY_UNKNOWN');
    if (limit.maxCards > machine.cards) throw new ApplicationError('POLICY_CAPACITY_EXCEEDED');
  }
  const sum = command.limits.reduce((total, limit) => total + limit.maxCards, 0);
  if (sum === 0 ? command.totalCards !== 0 : command.totalCards < 1 || command.totalCards > sum) {
    throw new ApplicationError('INVALID_COMPUTE_POLICY');
  }
}
