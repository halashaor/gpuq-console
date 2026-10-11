import {ApplicationError} from './errors.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export function nodeDispatchBinding(value) {
  if (!value || typeof value.dispatchId !== 'string' || !uuid.test(value.dispatchId)
    || typeof value.jobId !== 'string' || !uuid.test(value.jobId)
    || typeof value.machineId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.machineId)
    || typeof value.accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.accountId)
    || !Number.isSafeInteger(value.gpuCount) || value.gpuCount < 1 || value.gpuCount > 4096
    || !Number.isSafeInteger(value.nativeMaxGpus) || value.nativeMaxGpus < value.gpuCount || value.nativeMaxGpus > 4096
    || typeof value.requestHash !== 'string' || !digest.test(value.requestHash)
    || typeof value.nativeDigest !== 'string' || !digest.test(value.nativeDigest)
    || [value.nativeOwner, value.nativeName].some(text => typeof text !== 'string' || !text || text.length > 256 || text.includes('\0'))) {
    throw new ApplicationError('INVALID_NODE_DISPATCH_BINDING');
  }
  return {dispatchId: value.dispatchId, jobId: value.jobId, accountId: value.accountId, machineId: value.machineId,
    gpuCount: value.gpuCount, nativeMaxGpus: value.nativeMaxGpus, requestHash: value.requestHash, nativeDigest: value.nativeDigest,
    nativeOwner: value.nativeOwner, nativeName: value.nativeName};
}

export function nativeDispatchAcceptance(binding, receipt) {
  if (!receipt || receipt.submit_key !== binding.dispatchId || receipt.submit_digest !== binding.nativeDigest
    || receipt.owner !== binding.nativeOwner || receipt.name !== binding.nativeName || receipt.gpu_count !== binding.nativeMaxGpus
    || typeof receipt.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.job_id)) {
    throw new ApplicationError('NATIVE_DISPATCH_RECEIPT_MISMATCH');
  }
  return {dispatchId: binding.dispatchId, jobId: binding.jobId, accountId: binding.accountId, machineId: binding.machineId,
    gpuCount: binding.gpuCount, requestHash: binding.requestHash, nodeJobId: receipt.job_id};
}
