import {ACCOUNT_CHANGE_ROUTE, ACCOUNT_GET_ROUTE, ACCOUNT_CREATE_ROUTE, PASSWORD_RESET_ROUTE, parseAccountChange, parseAccountQuery, parseAccountCreate, parsePasswordReset} from '../contracts/account.mjs';
import {readJson, reply, replyError} from './json-http.mjs';

const statuses = {UNAUTHENTICATED: 401, FORBIDDEN: 403, ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_CHANGED: 409, ACCOUNT_EXISTS: 409, USERNAME_EXISTS: 409, LAST_ADMIN: 409, SELF_ACCOUNT_CHANGE: 409};

export function createAccountHandler({authenticate, changeAccount, getAccount, createAccount, resetPassword, reportError = console.error}) {
  return async (req, res) => {
    if (![ACCOUNT_CHANGE_ROUTE, ACCOUNT_GET_ROUTE, ACCOUNT_CREATE_ROUTE, PASSWORD_RESET_ROUTE].includes(req.url)) return reply(res, 404, {error: {code: 'NOT_FOUND'}});
    if (req.method !== 'POST') return reply(res, 405, {error: {code: 'METHOD_NOT_ALLOWED'}});
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(res, 415, {error: {code: 'JSON_REQUIRED'}});
    try {
      const actor = await authenticate(req);
      if (req.url === ACCOUNT_CREATE_ROUTE) {
        const command = parseAccountCreate(await readJson(req));
        return reply(res, 200, {result: await createAccount.execute(actor, command)});
      }
      if (req.url === PASSWORD_RESET_ROUTE) {
        const command = parsePasswordReset(await readJson(req));
        return reply(res, 200, {result: await resetPassword.execute(actor, command)});
      }
      if (req.url === ACCOUNT_GET_ROUTE) {
        const query = parseAccountQuery(await readJson(req));
        return reply(res, 200, {result: await getAccount.execute(actor, query)});
      }
      const command = parseAccountChange(await readJson(req));
      reply(res, 200, {result: await changeAccount.execute(actor, command)});
    } catch (error) {
      replyError(res, error, statuses, reportError);
    }
  };
}
