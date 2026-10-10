import {requireActiveSession} from './session-policy.mjs';
import {ApplicationError} from './errors.mjs';

/** Catalogue eligibility only: no claim about current usage, readiness or leases. */
export function trainingCandidates(actor, request, facts, now) {
  requireActiveSession(facts.session, now);
  if (facts.session.accountId !== actor.id || facts.session.sessionId !== actor.sessionId) throw new ApplicationError('UNAUTHENTICATED');
  if (!facts.project || facts.project.ownerId !== actor.id) throw new ApplicationError('FORBIDDEN');
  if (facts.project.archived) throw new ApplicationError('PROJECT_ARCHIVED');
  if (!facts.releaseExists) throw new ApplicationError('PROJECT_RELEASE_NOT_FOUND');
  const admin = facts.session.accountRole === 'admin';
  const selected = request.machines.kind === 'selected' ? request.machines.ids
    : facts.machines.filter(machine => admin || machine.granted).map(machine => machine.id);
  const candidates = [], excluded = [];
  for (const machineId of selected) {
    const machine = facts.machines.find(row => row.id === machineId);
    let reason;
    if (!machine || (!admin && !machine.granted)) reason = 'not-authorized';
    else if (!machine.enabled) reason = 'disabled';
    else if (!machine.releaseRegistered) reason = 'release-not-registered';
    else if (machine.cards === null) reason = 'capacity-unknown';
    else if (!admin && (machine.maxCards === null || facts.totalCards === null)) reason = 'quota-uninitialized';
    if (reason) {excluded.push({machineId, reason}); continue;}
    const maxConfiguredGpus = admin ? machine.cards : Math.min(machine.cards, machine.maxCards, facts.totalCards);
    if (maxConfiguredGpus < request.resources.minGpus) {excluded.push({machineId, reason: 'configured-limit-too-small'}); continue;}
    candidates.push({machineId, maxConfiguredGpus});
  }
  return {projectId: facts.project.id, projectRevision: facts.project.revision, release: request.project.release, candidates, excluded};
}
