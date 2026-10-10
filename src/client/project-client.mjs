import {PROJECT_REGISTRATION_ROUTES, parseProjectRegistration, parseProjectRegistrationResult} from '../contracts/project-registration.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class ProjectClient {
  constructor({transport}) {this.transport = transport;}
  registerRelease(request, options) {return this.#call(PROJECT_REGISTRATION_ROUTES.register, request, options, false);}
  registration(request, options) {return this.#call(PROJECT_REGISTRATION_ROUTES.get, request, options, true);}
  async #call(route, request, options, nullable) {
    const input = parseProjectRegistration(request);
    const response = await this.transport.request(route, input, options);
    const result = parseProjectRegistrationResult(response?.result);
    if (result === null) {if (!nullable) throw new InvalidResponse(); return null;}
    if (result.projectId !== input.projectId || result.machineId !== input.machineId || result.release !== input.release) throw new InvalidResponse();
    return result;
  }
}
