import {ApplicationError} from './errors.mjs';
import {requireActiveSession} from './session-policy.mjs';

/** All facts must come from the same write transaction. */
export function requireAccountRead(actor, facts, now) {
  requireActiveSession(facts.session, now);
  if (facts.session.accountId !== actor.id || facts.session.sessionId !== actor.sessionId) {
    throw new ApplicationError('UNAUTHENTICATED');
  }
  if (facts.session.accountRole !== 'admin') throw new ApplicationError('FORBIDDEN');
  if (!facts.target) throw new ApplicationError('ACCOUNT_NOT_FOUND');
}

export function requireAccountChange(actor, facts, command, now) {
  requireAccountRead(actor, facts, now);
  if (facts.target.revision !== command.revision) throw new ApplicationError('ACCOUNT_CHANGED');
  const removingAdmin = facts.target.role === 'admin'
    && (command.kind === 'role' ? command.role !== 'admin' : !command.enabled);
  if (removingAdmin && facts.otherEnabledAdmins === 0) throw new ApplicationError('LAST_ADMIN');
  if (actor.id === command.accountId && (command.kind === 'role' || !command.enabled)) {
    throw new ApplicationError('SELF_ACCOUNT_CHANGE');
  }
}

export function requirePasswordReset(actor, facts, command, now) {
  requireAccountRead(actor, facts, now);
  if (facts.target.revision !== command.revision) throw new ApplicationError('ACCOUNT_CHANGED');
}
