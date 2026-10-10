import {REGISTER_MANAGED_SOURCE_ROUTE, parseManagedRegistration, parseManagedRegistrationResult} from '../contracts/managed-registration.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class ManagedRegistrationClient {
  constructor({transport}) {this.transport = transport;}
  async register(request, options) {
    const input = parseManagedRegistration(request);
    const response = await this.transport.request(REGISTER_MANAGED_SOURCE_ROUTE, input, options);
    const result = parseManagedRegistrationResult(response?.result);
    if (result.machineId !== input.machineId || JSON.stringify(result.source) !== JSON.stringify(input.source)) throw new InvalidResponse();
    return result;
  }
}
