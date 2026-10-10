/** Intersect native legal counts with quota; never round a batch to an illegal size. */
export function trainingQuotaFit(resourceFit, balance) {
  const allowedGpuCounts = resourceFit.allowedGpuCounts.filter(count => count <= balance.remainingGpus);
  const exclusiveFreeFitGpuCount = resourceFit.exclusiveFreeFitGpuCount === null ? null
    : Math.max(0, ...allowedGpuCounts.filter(count => count <= resourceFit.exclusiveFreeFitGpuCount)) || null;
  return {balance, allowedGpuCounts, exclusiveFreeFitGpuCount,
    waitingFor: allowedGpuCounts.length ? resourceFit.waitingFor : 'quota'};
}
