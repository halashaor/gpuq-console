/** Filter native legal counts; never rewrite requested batch, LR or elastic bounds. */
export function trainingResourceFit(validated, candidate, pool) {
  const resources = validated.resources;
  if (resources.requested_gpu_uuids.some(id => !pool.gpuUuids.includes(id))) {
    return {eligible: false, reason: 'required-gpus-not-managed'};
  }
  const capacity = Math.min(pool.gpuUuids.length, candidate.maxConfiguredGpus);
  const allowedGpuCounts = validated.allowedGpuCounts.filter(count => count <= capacity);
  if (!allowedGpuCounts.length) return {eligible: false, reason: 'resource-capacity-too-small'};
  let exclusiveFreeFitGpuCount = null, waitingFor = null;
  if (!pool.dispatchEnabled) waitingFor = 'dispatch-disabled';
  else if (resources.share_gpu) waitingFor = 'sharing-admission';
  else {
    const free = resources.placement === 'pinned'
      ? resources.requested_gpu_uuids.filter(id => pool.freeGpuUuids.includes(id)).length : pool.freeGpuUuids.length;
    exclusiveFreeFitGpuCount = Math.max(0, ...allowedGpuCounts.filter(count => count <= free)) || null;
    if (exclusiveFreeFitGpuCount === null) waitingFor = 'free-capacity';
  }
  return {eligible: true, allowedGpuCounts, exclusiveFreeFitGpuCount, waitingFor};
}
