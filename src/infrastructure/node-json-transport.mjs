import {ApplicationError} from '../domain/errors.mjs';

/** Bounded authenticated node RPC. No redirect, discovery, retry or failover. */
export class NodeJsonTransport {
  #nodes = new Map();
  constructor({nodes, fetch = globalThis.fetch, timeoutMs = 5000}) {
    for (const {machineId, origin, credential} of nodes) {
      const url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
        || typeof machineId !== 'string' || !machineId || typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential) || this.#nodes.has(machineId)) {
        throw new TypeError('Invalid node configuration');
      }
      this.#nodes.set(machineId, {origin, credential});
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid node timeout');
    this.fetch = fetch; this.timeoutMs = timeoutMs;
  }

  async request(machineId, route, input) {
    const node = this.#nodes.get(machineId);
    if (!node) throw new ApplicationError('NODE_UNAVAILABLE');
    try {
      const url = new URL(route, node.origin);
      if (url.origin !== node.origin || url.username || url.password || !url.pathname.startsWith('/internal/v2/') || url.search || url.hash) throw new Error('Invalid node route');
      const signal = AbortSignal.timeout(this.timeoutMs), send = this.fetch;
      const response = await send(url, {method: 'POST', redirect: 'error', signal,
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${node.credential}`}, body: JSON.stringify(input)});
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403) throw new ApplicationError('FORBIDDEN');
        throw new Error('Node request rejected');
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 8192) throw new Error('Node response too large');
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks).toString('utf8')).result;
    } catch (cause) {
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      throw new ApplicationError('NODE_UNAVAILABLE', {cause});
    }
  }
}
