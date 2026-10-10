import {ApplicationError} from './errors.mjs';

import {requireActiveSession} from './session-policy.mjs';

export function requireDataReadPermission(actor,facts,nowMs){
  requireActiveSession(facts?.session,nowMs);
  if(facts.session.accountId!==actor.id||facts.session.sessionId!==actor.sessionId)throw new ApplicationError('UNAUTHENTICATED');
  requireDataSourcePermission(actor.id,facts.session.accountRole,facts);
}

/** Shared permission rules; callers separately establish session or task identity. */
export function requireDataSourcePermission(accountId,accountRole,facts){
  const machineAllowed=facts.machineEnabled&&(accountRole==='admin'||facts.machineGranted);
  if(!machineAllowed||!facts.source)throw new ApplicationError('FORBIDDEN');
  const source=facts.source;
  if(source.visibility!=='shared'&&source.ownerId!==accountId&&!source.readerGranted)throw new ApplicationError('FORBIDDEN');
}
