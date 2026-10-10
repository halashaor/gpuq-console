import {requireProjectObservation} from '../domain/project-observation.mjs';

export class RegisterProjectRelease {
  constructor({registrations, projects, clock = Date.now}) {
    this.registrations = registrations; this.projects = projects; this.clock = clock;
  }
  async execute(actor, request) {
    await this.registrations.authorize(actor, request, this.clock());
    let observed;
    try {
      observed = await this.projects.inspect({machineId: request.machineId, project: request.project, release: request.release}, {actor});
    } finally {
      await this.registrations.authorize(actor, request, this.clock());
    }
    requireProjectObservation(actor, request, observed);
    return this.registrations.register(actor, request, observed, this.clock());
  }
}
