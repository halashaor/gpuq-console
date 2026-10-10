import {COMPUTE_POLICY_ROUTES, parseComputePolicyQuery, parseComputePolicy} from '../contracts/compute-policy.mjs';
import {readJson, reply, replyError} from './json-http.mjs';

const statuses = {UNAUTHENTICATED: 401, FORBIDDEN: 403, ACCOUNT_NOT_FOUND: 404, MACHINE_NOT_FOUND: 404,
  ADMIN_POLICY_INHERITED: 409, POLICY_CHANGED: 409, POLICY_UNINITIALIZED: 409,
  MACHINE_CAPACITY_UNKNOWN: 409, POLICY_CAPACITY_EXCEEDED: 400, INVALID_COMPUTE_POLICY: 400};

export function createComputePolicyHandler({authenticate, getPolicy, setPolicy, reportError = console.error}) {
  const routes = new Map([
    [COMPUTE_POLICY_ROUTES.get, {parse: parseComputePolicyQuery, useCase: getPolicy}],
    [COMPUTE_POLICY_ROUTES.set, {parse: parseComputePolicy, useCase: setPolicy}],
  ]);
  return async (req, res) => {
    const route = routes.get(req.url);
    if (!route) return reply(res, 404, {error: {code: 'NOT_FOUND'}});
    if (req.method !== 'POST') return reply(res, 405, {error: {code: 'METHOD_NOT_ALLOWED'}});
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(res, 415, {error: {code: 'JSON_REQUIRED'}});
    try {
      const actor = await authenticate(req);
      const request = route.parse(await readJson(req));
      reply(res, 200, {result: await route.useCase.execute(actor, request)});
    } catch (error) {replyError(res, error, statuses, reportError);}
  };
}
