import {ObserveTrainingCandidates} from './observe-training-candidates.mjs';
import {ResolveTrainingData} from './resolve-training-data.mjs';

/** Worker entry: scopes every observation to one durable task, without a login session. */
export class ObserveTaskCandidates {
  constructor({authority, catalog, projects, sources, resources, quota}) {
    this.authority = authority; this.catalog = catalog; this.projects = projects;
    this.sources = sources; this.resources = resources; this.quota = quota;
  }

  async execute(jobId) {
    const context = await this.authority.context(jobId);
    const observer = new ObserveTrainingCandidates({
      catalog: {snapshot: () => this.catalog.snapshotForTask(jobId)},
      projects: this.projects, resources: this.resources,
      data: new ResolveTrainingData({sources: this.sources,
        access: {requireRead: (_actor, request) => this.authority.requireDataRead(jobId, request)}}),
      quota: {balances: (_actor, machineIds) => this.quota.balancesForTask(jobId, machineIds)},
    });
    return observer.execute({id: context.accountId}, context.submission);
  }
}
