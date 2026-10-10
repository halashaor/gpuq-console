import {prepareObservedDispatch} from './prepare-training-dispatch.mjs';

/** Worker-only preparation for one queued job; no interactive session or node send. */
export class PrepareTaskDispatch {
  constructor({observer, dispatches, clock = Date.now}) {
    this.observer = observer; this.dispatches = dispatches; this.clock = clock;
  }
  execute(jobId) {
    return prepareObservedDispatch(jobId, {
      readExisting: () => this.dispatches.getForTask(jobId),
      observe: () => this.observer.execute(jobId),
      prepare: selection => this.dispatches.prepareForTask(jobId, selection, this.clock()),
    });
  }
}
