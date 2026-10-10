import {
  ACCOUNT_CHANGE_ROUTE, ACCOUNT_GET_ROUTE, ACCOUNT_CREATE_ROUTE, ACCOUNT_LIST_ROUTE, PASSWORD_RESET_ROUTE,
  parseAccountChange, parseAccountQuery, parseAccountCreate, parseAccountListQuery, parsePasswordReset,
} from '../contracts/account.mjs';
import {readJson, reply, replyError} from './json-http.mjs';

const statuses = {UNAUTHENTICATED: 401, FORBIDDEN: 403, ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_CHANGED: 409, ACCOUNT_EXISTS: 409, USERNAME_EXISTS: 409, LAST_ADMIN: 409, SELF_ACCOUNT_CHANGE: 409};

export function createAccountHandler({authenticate, changeAccount, getAccount, createAccount, resetPassword, listAccounts, reportError = console.error}) {
  const routes = new Map([
    [ACCOUNT_CREATE_ROUTE, {parse: parseAccountCreate, useCase: createAccount}],
    [ACCOUNT_CHANGE_ROUTE, {parse: parseAccountChange, useCase: changeAccount}],
    [ACCOUNT_GET_ROUTE, {parse: parseAccountQuery, useCase: getAccount}],
    [PASSWORD_RESET_ROUTE, {parse: parsePasswordReset, useCase: resetPassword}],
    [ACCOUNT_LIST_ROUTE, {parse: parseAccountListQuery, useCase: listAccounts}],
  ]);
  return async (req, res) => {
    const route = routes.get(req.url);
    if (!route) return reply(res, 404, {error: {code: 'NOT_FOUND'}});
    if (req.method !== 'POST') return reply(res, 405, {error: {code: 'METHOD_NOT_ALLOWED'}});
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(res, 415, {error: {code: 'JSON_REQUIRED'}});
    try {
      const actor = await authenticate(req);
      const input = route.parse(await readJson(req));
      reply(res, 200, {result: await route.useCase.execute(actor, input)});
    } catch (error) {
      replyError(res, error, statuses, reportError);
    }
  };
}
