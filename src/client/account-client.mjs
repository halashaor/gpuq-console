import {ACCOUNT_CHANGE_ROUTE, ACCOUNT_GET_ROUTE, parseAccountChange, parseAccountQuery, parseAccountResult} from '../contracts/account.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class AccountClient {
  constructor({transport}) {this.transport = transport;}

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
