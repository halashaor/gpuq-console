import {
  ACCOUNT_CHANGE_ROUTE, ACCOUNT_GET_ROUTE, ACCOUNT_CREATE_ROUTE, ACCOUNT_LIST_ROUTE, PASSWORD_RESET_ROUTE,
  parseAccountChange, parseAccountQuery, parseAccountCreate, parseAccountResult, parsePasswordReset,
  parseAccountListQuery, parseAccountListResult,
} from '../contracts/account.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class AccountClient {
  constructor({transport}) {this.transport = transport;}

  async list(request = {after: null, limit: 50}, options) {
    const query = parseAccountListQuery(request);
    const response = await this.transport.request(ACCOUNT_LIST_ROUTE, query, options);
    const result = parseAccountListResult(response?.result);
    if (result.accounts.length > query.limit || result.accounts.some(account => account.id === query.after)) throw new InvalidResponse();
    return result;
  }

  async create(request, options) {
    const command = parseAccountCreate(request);
    const response = await this.transport.request(ACCOUNT_CREATE_ROUTE, command, options);
    const result = parseAccountResult(response?.result);
    if (result.id !== command.accountId) throw new InvalidResponse();
    return result;
  }

  async resetPassword(request, options) {
    const command = parsePasswordReset(request);
    const response = await this.transport.request(PASSWORD_RESET_ROUTE, command, options);
    const result = parseAccountResult(response?.result);
    if (result.id !== command.accountId) throw new InvalidResponse();
    return result;
  }

  async get(request, options) {
    const query = parseAccountQuery(request);
    const response = await this.transport.request(ACCOUNT_GET_ROUTE, query, options);
    const result = parseAccountResult(response?.result);
    if (result.id !== query.accountId) throw new InvalidResponse();
    return result;
  }

  async change(request, options) {
    const command = parseAccountChange(request);
    const response = await this.transport.request(ACCOUNT_CHANGE_ROUTE, command, options);
    const result = parseAccountResult(response?.result);
    if (result.id !== command.accountId) throw new InvalidResponse();
    return result;
  }
}
