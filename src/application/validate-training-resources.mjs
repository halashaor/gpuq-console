import {ApplicationError} from '../domain/errors.mjs';

/** Parsed user intent + a trusted node's pool, not client-supplied inventory. */
export class ValidateTrainingResources {
  constructor({policy}) {this.policy = policy;}

  async execute(submission, {gpuUuids}) {
    if (!Array.isArray(gpuUuids) || gpuUuids.some(id => typeof id !== 'string' || !/^GPU-[A-Za-z0-9][A-Za-z0-9-]*$/.test(id))
      || new Set(gpuUuids).size !== gpuUuids.length) throw new ApplicationError('GPU_INVENTORY_INVALID');
    if (!gpuUuids.length) throw new ApplicationError('GPU_POOL_EMPTY');
    const r = submission.resources, s = submission.scheduling, hami = r.sharing?.hami ?? null;
    return this.policy.resources({pool_size: gpuUuids.length, managed_gpu_uuids: [...gpuUuids], request: {
      priority: s.priority, dispatch_mode: s.mode, checkpoint_capability: s.checkpoint, restart_policy: s.restart,
      yield_policy: s.yieldPolicy, preempt_opt_in_only: true,
      gpu_count: r.maxGpus, min_gpu_count: r.minGpus, elastic_gpu_count: r.elastic, auto_scale_up: r.autoScaleUp,
      placement: r.placement, requested_gpu_uuids: [...r.gpuUuids],
      target_global_batch_size: r.batch?.globalBatchSize ?? null, per_device_micro_batch_size: r.batch?.microBatchSize ?? null,
      share_gpu: r.sharing !== null, vram_mb: r.sharing?.vramMiB ?? null,
      hami_core: hami !== null, sm_percent: hami?.smPercent ?? null, env: {...submission.execution.env},
    }});
  }
}
