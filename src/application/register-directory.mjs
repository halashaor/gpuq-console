import {ApplicationError} from '../domain/errors.mjs';

export class RegisterDirectory {
  constructor({registrations, configuredSources, clock = Date.now}) {
    this.registrations = registrations;
    this.configuredSources = configuredSources;
    this.clock = clock;
  }

  async execute(actor, request) {
    await this.registrations.authorize(actor, this.clock());
    const source = await this.configuredSources.find(request);
    if (!source) throw new ApplicationError('SOURCE_NOT_CONFIGURED');
    return this.registrations.register(actor, request, source, this.clock());
  }
}
