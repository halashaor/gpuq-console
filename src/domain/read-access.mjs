import {ApplicationError} from './errors.mjs';

export function requireActiveSession(session,nowMs){
  if(!session||!session.accountEnabled||session.revoked||session.expiresAtMs<=nowMs
    ||session.accountRevision!==session.sessionRevision)throw new ApplicationError('UNAUTHENTICATED');
}

export function requireDataReadPermission(actor,facts,nowMs){
  requireActiveSession(facts?.session,nowMs);
  if(facts.session.accountId!==actor.id||facts.session.sessionId!==actor.sessionId)throw new ApplicationError('UNAUTHENTICATED');
  const machineAllowed=facts.machineEnabled&&(facts.session.accountRole==='admin'||facts.machineGranted);
  if(!machineAllowed||!facts.source)throw new ApplicationError('FORBIDDEN');
  const source=facts.source;
  if(source.visibility!=='shared'&&source.ownerId!==actor.id&&!source.readerGranted)throw new ApplicationError('FORBIDDEN');
}
