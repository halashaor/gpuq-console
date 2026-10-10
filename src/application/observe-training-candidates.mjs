import {ApplicationError} from '../domain/errors.mjs';
import {requireProjectObservation, requireProjectRuntimeObservation} from '../domain/project-observation.mjs';

/** Existing project/runtime references, not execution admission or GPU reservations. */
export class ObserveTrainingCandidates {
  constructor({catalog, projects, data, resources, clock = Date.now}) {
    this.catalog = catalog; this.projects = projects; this.data = data; this.resources = resources; this.clock = clock;
  }
  async execute(actor, request) {
    const snapshot = await this.catalog.snapshot(actor, request, this.clock());
    const unchanged = async () => {
      const current = await this.catalog.snapshot(actor, request, this.clock());
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new ApplicationError('TRAINING_CONTEXT_CHANGED');
    };
    const candidates = [], excluded = [...snapshot.excluded];
    let resourceRequest;
    try {resourceRequest = await this.resources.validate(request);}
    finally {await unchanged();}
    for (const candidate of snapshot.candidates) {
      const instance = snapshot.instances.find(row => row.machineId === candidate.machineId);
      if (!instance) {excluded.push({machineId: candidate.machineId, reason: 'instance-not-registered'}); continue;}
      let resourceFit;
      try {resourceFit = await this.resources.execute(resourceRequest, candidate);}
      catch (error) {
        if (!['GPU_POOL_UNAVAILABLE', 'GPU_POOL_NODE_MISMATCH'].includes(error.code)) throw error;
        excluded.push({machineId: candidate.machineId, reason: 'resource-unavailable'}); continue;
      } finally {await unchanged();}
      if (!resourceFit.eligible) {excluded.push({machineId: candidate.machineId, reason: resourceFit.reason}); continue;}
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
      let runtime;
      try {
        runtime = await this.projects.verifyRuntime(reference, {actor});
      } catch (error) {
        if (!['PROJECT_NODE_UNAVAILABLE', 'PROJECT_SOURCE_UNAVAILABLE', 'PROJECT_NODE_MISMATCH'].includes(error.code)) throw error;
        excluded.push({machineId: candidate.machineId, reason: 'runtime-unavailable'});
        continue;
      } finally {await unchanged();}
      try {requireProjectRuntimeObservation(actor, reference, runtime);}
      catch (error) {
        if (!['PROJECT_NOT_ACTIVE', 'PROJECT_OBSERVATION_INVALID'].includes(error.code)) throw error;
        excluded.push({machineId: candidate.machineId, reason: error.code === 'PROJECT_NOT_ACTIVE' ? 'project-inactive' : 'invalid-runtime-observation'});
        continue;
      }
      if (runtime.projectUUID !== instance.projectUUID || runtime.generation !== instance.generation
        || runtime.environmentMode !== observation.environmentMode) {
        excluded.push({machineId: candidate.machineId, reason: 'instance-changed'}); continue;
      }
      let reads;
      try {
        reads = await this.data.execute(actor, {machineId: candidate.machineId, sources: request.dataSources});
      } catch (error) {
        if (!['FORBIDDEN', 'TRAINING_DATA_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 'SOURCE_NODE_UNAVAILABLE'].includes(error.code)) throw error;
        excluded.push({machineId: candidate.machineId, reason: error.code === 'FORBIDDEN' ? 'data-not-authorized' : 'data-unavailable'});
        continue;
      } finally {await unchanged();}
      candidates.push({...candidate, ...instance, environmentMode: runtime.environmentMode,
        runtimeIdentityVerified: true, runtime: {...runtime.runtime}, dataReads: reads, resourceFit});
    }
    for (const candidate of candidates) {
      await this.data.requireAccess(actor, {machineId: candidate.machineId, sources: request.dataSources});
    }
    await unchanged();
    return {projectId: snapshot.projectId, projectRevision: snapshot.projectRevision, release: snapshot.release, candidates, excluded};
  }
}
