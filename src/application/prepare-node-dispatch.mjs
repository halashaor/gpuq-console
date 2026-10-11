import {ApplicationError} from '../domain/errors.mjs';

/** Node-internal preparation from an operator-built native command, never public host argv. */
export class PrepareNodeDispatch {
  constructor({launchSpec, bindings}) {this.launchSpec = launchSpec; this.bindings = bindings;}
  async execute(identity, nativeSubmission, pool) {
    if (nativeSubmission.submit_key !== identity.dispatchId) throw new ApplicationError('NODE_LAUNCH_IDENTITY_MISMATCH');
    const built = await this.launchSpec.build(nativeSubmission, pool);
    if (!built.allowedGpuCounts.includes(identity.gpuCount)) throw new ApplicationError('NODE_INITIAL_GPU_COUNT_INVALID');
    return this.bindings.prepare({...identity, nativeDigest: built.nativeDigest,
      nativeMaxGpus: built.submission.gpu_count, nativeOwner: built.submission.owner, nativeName: built.submission.name}, built);
  }
}
