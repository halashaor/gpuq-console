import {COMPUTE_POLICY_ROUTES, parseComputePolicyQuery, parseComputePolicy, parseComputePolicyResult} from '../contracts/compute-policy.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class ComputePolicyClient {
  constructor({transport}) {this.transport = transport;}
  async get(request, options) {
    const query = parseComputePolicyQuery(request);
    const response = await this.transport.request(COMPUTE_POLICY_ROUTES.get, query, options);
    const result = parseComputePolicyResult(response?.result);
    if (result.accountId !== query.accountId) throw new InvalidResponse();
    return result;
  }
  async set(request, options) {
    const command = parseComputePolicy(request);
    const response = await this.transport.request(COMPUTE_POLICY_ROUTES.set, command, options);
    const result = parseComputePolicyResult(response?.result);
    if (result.accountId !== command.accountId) throw new InvalidResponse();
    return result;
  }
}
