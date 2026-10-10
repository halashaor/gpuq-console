import {ApplicationError} from '../domain/errors.mjs';
import {requireProjectObservation} from '../domain/project-observation.mjs';

/** Current project metadata observations, not runtime admission or GPU reservations. */
export class ObserveTrainingCandidates {
  constructor({catalog, projects, clock = Date.now}) {this.catalog = catalog; this.projects = projects; this.clock = clock;}
  async execute(actor, request) {
    const snapshot = await this.catalog.snapshot(actor, request, this.clock());
    const unchanged = async () => {
      const current = await this.catalog.snapshot(actor, request, this.clock());
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new ApplicationError('TRAINING_CONTEXT_CHANGED');
    };
    const candidates = [], excluded = [...snapshot.excluded];
    for (const candidate of snapshot.candidates) {
      const instance = snapshot.instances.find(row => row.machineId === candidate.machineId);
      if (!instance) {excluded.push({machineId: candidate.machineId, reason: 'instance-not-registered'}); continue;}
      const reference = {machineId: candidate.machineId, project: instance.project, release: request.project.release};
      let observation;
      try {
        observation = await this.projects.inspect(reference, {actor});
      } catch (error) {
        if (!['PROJECT_NODE_UNAVAILABLE', 'PROJECT_SOURCE_UNAVAILABLE', 'PROJECT_NODE_MISMATCH'].includes(error.code)) throw error;
        excluded.push({machineId: candidate.machineId, reason: 'node-unavailable'});
        continue;
      } finally {await unchanged();}
      try {requireProjectObservation(actor, reference, observation);}
      catch (error) {
        if (!['PROJECT_NOT_ACTIVE', 'PROJECT_OBSERVATION_INVALID'].includes(error.code)) throw error;
        excluded.push({machineId: candidate.machineId, reason: error.code === 'PROJECT_NOT_ACTIVE' ? 'project-inactive' : 'invalid-observation'});
        continue;
      }
      if (observation.projectUUID !== instance.projectUUID || observation.generation !== instance.generation) {
        excluded.push({machineId: candidate.machineId, reason: 'instance-changed'}); continue;
      }
      candidates.push({...candidate, ...instance, environmentMode: observation.environmentMode, runtimeVerified: false});
    }
    await unchanged();
    return {projectId: snapshot.projectId, projectRevision: snapshot.projectRevision, release: snapshot.release, candidates, excluded};
  }
}
