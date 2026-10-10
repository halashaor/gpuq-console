import {
  ACCOUNT_CHANGE_ROUTE, ACCOUNT_GET_ROUTE, ACCOUNT_CREATE_ROUTE, ACCOUNT_LIST_ROUTE, PASSWORD_RESET_ROUTE,
  parseAccountChange, parseAccountQuery, parseAccountCreate, parseAccountListQuery, parsePasswordReset,
} from '../contracts/account.mjs';
import {createJsonRoutes} from './json-http.mjs';

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
  return createJsonRoutes({routes, authenticate, statuses, reportError});
}
