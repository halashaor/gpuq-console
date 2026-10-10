import {requireAdministrator} from './account-policy.mjs';
import {ApplicationError} from './errors.mjs';

export function requireDataAccessManagement(actor, facts, now) {
  requireAdministrator(actor, facts.session, now);
  if (!facts.resource) throw new ApplicationError('DATA_RESOURCE_NOT_FOUND');
}

export function requireDataReadersChange(facts, command) {
  if (facts.resource.revision !== command.revision) throw new ApplicationError('DATA_ACCESS_CHANGED');
  // Shared sources already allow all machine-authorized users. Editing a list
  // cannot revoke that access; visibility is a separate registration decision.
  if (facts.resource.visibility === 'shared') throw new ApplicationError('DATA_SOURCE_SHARED');
  if (facts.knownReaders !== command.readers.length) throw new ApplicationError('ACCOUNT_NOT_FOUND');
}
