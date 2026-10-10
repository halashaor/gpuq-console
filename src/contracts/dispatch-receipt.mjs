import {InvalidRequest, InvalidResponse} from './errors.mjs';

export const DISPATCH_RECEIPT_ROUTE = '/internal/v2/dispatch/receipt';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

export function parseDispatchReceiptRequest(value) {
  if (!exact(value, ['machineId', 'dispatchId']) || typeof value.machineId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.machineId)
    || typeof value.dispatchId !== 'string' || !uuid.test(value.dispatchId)) throw new InvalidRequest('dispatch');
  return {machineId: value.machineId, dispatchId: value.dispatchId};
}

export function parseDispatchReceipt(value) {
  if (value === null) return null;
  try {
    if (!exact(value, ['dispatchId', 'jobId', 'accountId', 'machineId', 'gpuCount', 'requestHash', 'nodeJobId'])
      || typeof value.jobId !== 'string' || !uuid.test(value.jobId)
      || typeof value.accountId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.accountId)
      || !Number.isSafeInteger(value.gpuCount) || value.gpuCount < 1 || value.gpuCount > 4096
      || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestHash)
      || typeof value.nodeJobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.nodeJobId)) throw new InvalidResponse();
    parseDispatchReceiptRequest({machineId: value.machineId, dispatchId: value.dispatchId});
    return {...value};
  } catch {throw new InvalidResponse();}
}
