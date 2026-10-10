import {timingSafeEqual} from 'node:crypto';
import {ApplicationError} from '../domain/errors.mjs';

export function createNodeAuthenticator(credential) {
  if (typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential)) throw new TypeError('Invalid node credential');
  const expected = Buffer.from(credential, 'hex');
  return async req => {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!supplied || !timingSafeEqual(Buffer.from(supplied, 'hex'), expected)) throw new ApplicationError('UNAUTHENTICATED');
    return {id: 'coordinator'};
  };
}
