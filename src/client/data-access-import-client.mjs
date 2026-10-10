import {DATA_ACCESS_IMPORT_ROUTES, parseImportPlanRequest, parseImportApplyRequest, parseImportReceiptRequest,
  parseImportPlanResult, parseImportReceiptResult} from '../contracts/data-access-import.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

export class DataAccessImportClient {
  constructor({transport}) {this.transport = transport;}
  async plan(request, options) {
    const input = parseImportPlanRequest(request);
    const response = await this.transport.request(DATA_ACCESS_IMPORT_ROUTES.plan, input, options);
    const result = parseImportPlanResult(response?.result);
    if (result.resourceId !== input.resourceId) throw new InvalidResponse();
    return result;
  }
  async apply(request, options) {
    const input = parseImportApplyRequest(request);
    const response = await this.transport.request(DATA_ACCESS_IMPORT_ROUTES.apply, input, options);
    const result = parseImportReceiptResult(response?.result);
    if (!result || result.requestId !== input.requestId || result.resourceId !== input.resourceId) throw new InvalidResponse();
    return result;
  }
  async receipt(request, options) {
    const input = parseImportReceiptRequest(request);
    const response = await this.transport.request(DATA_ACCESS_IMPORT_ROUTES.receipt, input, options);
    const result = parseImportReceiptResult(response?.result);
    if (result && result.requestId !== input.requestId) throw new InvalidResponse();
    return result;
  }
}
