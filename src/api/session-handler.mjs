import {SESSION_ROUTES, parseLoginRequest, parseEmptyRequest} from '../contracts/session.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {readJson, reply, replyError} from './json-http.mjs';

const statusByCode = {
  UNAUTHENTICATED: 401, INVALID_CREDENTIALS: 401, FORBIDDEN: 403,
  LOGIN_BUSY: 429, LOGIN_RATE_LIMIT: 429, SESSION_LIMIT: 409, AUTHENTICATION_CHANGED: 409,
};

/** Transport delivery differs; authentication and session state do not. */
export function createSessionHandler({login, lifecycle, authenticate, publicOrigin, reportError = console.error}) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:'
    && !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))) throw new Error('Invalid public origin');
  const cookie = (credential, maxAge) => `gpuq_session=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
    + (origin.protocol === 'https:' ? '; Secure' : '');

  return async (req, res) => {
    if (!Object.values(SESSION_ROUTES).includes(req.url)) return reply(res, 404, {error: {code: 'NOT_FOUND'}});
    if (req.method !== 'POST') return reply(res, 405, {error: {code: 'METHOD_NOT_ALLOWED'}});
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return reply(res, 415, {error: {code: 'JSON_REQUIRED'}});
    }
    try {
      if (req.headers.origin !== undefined && req.headers.origin !== publicOrigin) throw new ApplicationError('FORBIDDEN');
      if (req.url === SESSION_ROUTES.login) {
        const input = parseLoginRequest(await readJson(req));
        if (input.delivery === 'cookie' && req.headers.origin !== publicOrigin) throw new ApplicationError('FORBIDDEN');
        const issued = await login.execute(input);
        const result = {account: issued.account, expiresAtMs: issued.expiresAtMs};
        if (input.delivery === 'token') return reply(res, 200, {result: {...result, credential: issued.credential}});
        return reply(res, 200, {result}, {'Set-Cookie': cookie(issued.credential, 365 * 86400)});
      }
      const actor = await authenticate(req);
      parseEmptyRequest(await readJson(req));
      if (req.url === SESSION_ROUTES.current) return reply(res, 200, {result: await lifecycle.current(actor)});
      if (req.url === SESSION_ROUTES.refresh) return reply(res, 200, {result: await lifecycle.refresh(actor)});
      await lifecycle.logout(actor);
      const headers = req.headers.authorization === undefined ? {'Set-Cookie': cookie('', 0)} : {};
      reply(res, 200, {result: {revoked: true}}, headers);
    } catch (error) {
      replyError(res, error, statusByCode, reportError);
    }
  };
}
