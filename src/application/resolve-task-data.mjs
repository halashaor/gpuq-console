import {ResolveTrainingData} from './resolve-training-data.mjs';

/** Worker-only data observation derived from a queued request, never a login token. */
export class ResolveTaskData {
  constructor({authority, sources}) {this.authority = authority; this.sources = sources;}
  async execute(jobId, machineId) {
    const context = await this.authority.context(jobId);
    const reads = new ResolveTrainingData({sources: this.sources, access: {
      requireRead: (_actor, request) => this.authority.requireDataRead(jobId, request),
    }});
    try {
      return await reads.execute({id: context.accountId}, {machineId, sources: context.submission.dataSources});
    } finally {await this.authority.context(jobId);}
  }
}
