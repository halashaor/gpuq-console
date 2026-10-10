/** Prepare only: read the immutable request, observe candidates, then hold quota. */
export class PrepareTrainingDispatch {
  constructor({requests, observer, dispatches, clock = Date.now}) {
    this.requests = requests; this.observer = observer; this.dispatches = dispatches; this.clock = clock;
  }

  async execute(actor, jobId) {
    return prepareObservedDispatch(jobId, {
      readExisting: () => this.dispatches.get(actor, jobId, this.clock()),
      observe: async () => this.observer.execute(actor, await this.requests.submission(actor, jobId, this.clock())),
      prepare: selection => this.dispatches.prepare(actor, {jobId, ...selection}, this.clock()),
    });
  }
}

/** One selection/recovery flow for interactive and task-scoped preparation. */
export async function prepareObservedDispatch(jobId, {readExisting, observe, prepare}) {
    const existing = await readExisting();
    if (existing) return {kind: 'prepared', dispatch: existing};
    const observed = await observe();
    // Highest currently fitting legal count; original candidate order breaks ties.
    const candidate = observed.candidates.filter(row => row.quotaFit.exclusiveFreeFitGpuCount !== null)
      .sort((a, b) => b.quotaFit.exclusiveFreeFitGpuCount - a.quotaFit.exclusiveFreeFitGpuCount)[0];
    if (!candidate) return {kind: 'waiting', jobId, reason: 'no-current-exclusive-fit'};
    try {
      const dispatch = await prepare({machineId: candidate.machineId, gpuCount: candidate.quotaFit.exclusiveFreeFitGpuCount});
      return {kind: 'prepared', dispatch};
    } catch (error) {
      if (error.code === 'COMPUTE_QUOTA_EXCEEDED') return {kind: 'waiting', jobId, reason: 'quota-changed'};
      if (error.code === 'TRAINING_DISPATCH_CONFLICT') {
        const dispatch = await readExisting();
        if (dispatch) return {kind: 'prepared', dispatch};
      }
      throw error;
    }
}
