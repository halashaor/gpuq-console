import {DATA_ACCESS_ROUTES, parseDataAccessQuery, parseDataReaders, parseDataAccessResult} from '../contracts/data-access.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class DataAccessClient {
  constructor({transport}) {this.transport = transport;}
  async get(request, options) {
    const query = parseDataAccessQuery(request);
    const response = await this.transport.request(DATA_ACCESS_ROUTES.get, query, options);
    const result = parseDataAccessResult(response?.result);
    if (result.resourceId !== query.resourceId) throw new InvalidResponse();
    return result;
  }
  async setReaders(request, options) {
    const command = parseDataReaders(request);
    const response = await this.transport.request(DATA_ACCESS_ROUTES.set, command, options);
    const result = parseDataAccessResult(response?.result);
    if (result.resourceId !== command.resourceId) throw new InvalidResponse();
    return result;
  }
}
