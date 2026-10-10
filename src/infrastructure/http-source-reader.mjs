import {SOURCE_INSPECTION_ROUTE, SOURCE_ACCESS_ROUTE, parseSourceInspection, parseSourceAccessResult} from '../contracts/source-inspection.mjs';
import {parseDataReadResult} from '../contracts/data-read.mjs';
import {ApplicationError} from '../domain/errors.mjs';

/** Trusted node inventory is explicit; no discovery, failover or automatic retry. */
export class HttpSourceReader {
  #nodes = new Map();
  constructor({nodes, fetch = globalThis.fetch, timeoutMs = 5000}) {
    for (const {machineId, origin, credential} of nodes) {
      const url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
        || typeof machineId !== 'string' || !machineId || !/^[a-f0-9]{64}$/.test(credential) || this.#nodes.has(machineId)) {
        throw new TypeError('Invalid source node configuration');
      }
      this.#nodes.set(machineId, {origin, credential});
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid node timeout');
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async inspect(request, {actor} = {}) {
    const result = await this.#query(SOURCE_INSPECTION_ROUTE, request, actor, parseDataReadResult);
    return result.availability === 'available' ? {availability: 'available'} : {availability: result.availability, reason: result.reason};
  }

  async exportAccess(request, {actor} = {}) {
    return this.#query(SOURCE_ACCESS_ROUTE, request, actor, parseSourceAccessResult);
  }

  async #query(route, request, actor, decode) {
    const input = parseSourceInspection({request, accountId: actor?.id});
    const node = this.#nodes.get(request.machineId);
    if (!node) throw new ApplicationError('SOURCE_NODE_UNAVAILABLE');
    const send = this.fetch;
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const response = await send(new URL(route, node.origin), {
        method: 'POST', redirect: 'error', signal,
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${node.credential}`},
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403) throw new ApplicationError('FORBIDDEN');
        throw new Error('Node inspection rejected');
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 8192) throw new Error('Node observation too large');
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      const result = decode(JSON.parse(Buffer.concat(chunks).toString('utf8')).result);
      if (result.machineId !== request.machineId || JSON.stringify(result.source) !== JSON.stringify(request.source)) {
        throw new Error('Node observation identity mismatch');
      }
      return result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('SOURCE_NODE_UNAVAILABLE', {cause});
    }
  }
}
