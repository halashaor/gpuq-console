export class GetProjectRegistration {
  constructor({registrations, clock = Date.now}) {this.registrations = registrations; this.clock = clock;}
  async execute(actor, request) {return this.registrations.get(actor, request, this.clock());}
}
