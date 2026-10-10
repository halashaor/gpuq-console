import {ApplicationError} from '../domain/errors.mjs';

export class RegisterManagedSource {
  constructor({registrations, configuredVersions, sources, clock = Date.now}) {
    this.registrations = registrations;
    this.configuredVersions = configuredVersions;
    this.sources = sources;
    this.clock = clock;
  }
  async execute(actor, request) {
    await this.registrations.authorize(actor, this.clock());
    const metadata = await this.configuredVersions.find(request);
    if (!metadata) throw new ApplicationError('SOURCE_NOT_CONFIGURED');
    let observed;
    try {
      observed = await this.sources.inspect(request, {actor: {id: metadata.ownerId}});
    } finally {
      await this.registrations.authorize(actor, this.clock());
    }
    if (observed.availability !== 'available') throw new ApplicationError('SOURCE_NOT_READY');
    return this.registrations.register(actor, request, metadata, this.clock());
  }
}
