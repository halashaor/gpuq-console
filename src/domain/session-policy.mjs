import {ApplicationError} from './errors.mjs';

export const SESSION_POLICY = {
  idleMs: 30 * 86400_000,
  touchMs: 3600_000,
  perAccount: 128,
  total: 100000,
};

export const LOGIN_POLICY = {failures: 5, windowMs: 60000, concurrent: 2};

export function requireActiveSession(session, nowMs) {
  if (!session || !session.accountEnabled || session.revoked || session.expiresAtMs <= nowMs
    || session.accountRevision !== session.sessionRevision) throw new ApplicationError('UNAUTHENTICATED');
}
