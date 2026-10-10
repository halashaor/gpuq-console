import {REGISTER_DIRECTORY_ROUTE, parseDirectoryRegistration, parseDirectoryRegistrationResult} from '../contracts/directory-registration.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class DirectoryClient {
  constructor({transport}) {this.transport = transport;}
  async register(request, options) {
    const input = parseDirectoryRegistration(request);
    const response = await this.transport.request(REGISTER_DIRECTORY_ROUTE, input, options);
    const result = parseDirectoryRegistrationResult(response?.result);
    if (result.machineId !== input.machineId || result.sourceId !== input.sourceId) throw new InvalidResponse();
    return result;
  }
}
