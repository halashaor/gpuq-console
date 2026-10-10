import {ApplicationError} from './errors.mjs';

/** Authorization bounds only; native policy and live admission still validate execution. */
export function requireTaskPlacement(submission, {machineId, gpuCount}) {
  const resources = submission.resources;
  if ((submission.machines.kind === 'selected' && !submission.machines.ids.includes(machineId))
    || !Number.isSafeInteger(gpuCount) || gpuCount < resources.minGpus || gpuCount > resources.maxGpus
    || (!resources.elastic && gpuCount !== resources.maxGpus)) throw new ApplicationError('TASK_SCOPE_MISMATCH');
}
