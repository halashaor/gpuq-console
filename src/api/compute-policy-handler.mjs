import {COMPUTE_POLICY_ROUTES, parseComputePolicyQuery, parseComputePolicy} from '../contracts/compute-policy.mjs';
import {createJsonRoutes} from './json-http.mjs';

const statuses = {UNAUTHENTICATED: 401, FORBIDDEN: 403, ACCOUNT_NOT_FOUND: 404, MACHINE_NOT_FOUND: 404,
  ADMIN_POLICY_INHERITED: 409, POLICY_CHANGED: 409, POLICY_UNINITIALIZED: 409,
  MACHINE_CAPACITY_UNKNOWN: 409, POLICY_CAPACITY_EXCEEDED: 400, INVALID_COMPUTE_POLICY: 400};

export function createComputePolicyHandler({authenticate, getPolicy, setPolicy, reportError = console.error}) {
  const routes = new Map([
    [COMPUTE_POLICY_ROUTES.get, {parse: parseComputePolicyQuery, useCase: getPolicy}],
    [COMPUTE_POLICY_ROUTES.set, {parse: parseComputePolicy, useCase: setPolicy}],
  ]);
  return createJsonRoutes({routes, authenticate, statuses, reportError});
}
