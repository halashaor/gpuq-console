import {SESSION_ROUTES, parseLoginRequest, parseLoginResult, parseExpiryResult, parseLogoutResult} from '../contracts/session.mjs';
import {ApiError} from './errors.mjs';
import {JsonHttpTransport} from './http-transport.mjs';

/** Cookie/token delivery is explicit. No automatic login retry or disk storage. */
export class SessionClient {
  #busy = false;

  constructor({transport, delivery}) {
    if (!['cookie', 'token'].includes(delivery)) throw new ApiError('INVALID_SESSION_DELIVERY');
    this.transport = transport;
    this.delivery = delivery;
  }

  async login({username, password}, options) {
    const input = parseLoginRequest({username, password, delivery: this.delivery});
    return this.#exclusive(async () => {
      // Old cookies can remain in the browser after a failed login. Keep business
      // requests closed until a new identity has actually been confirmed.
      this.transport.session.close();
      const revision = this.transport.session.snapshot().revision;
      const anonymous = new JsonHttpTransport({baseUrl: this.transport.baseUrl, fetch: this.transport.fetch});
      const response = await anonymous.request(SESSION_ROUTES.login, input, options);
      if (this.transport.session.snapshot().revision !== revision) throw new ApiError('SESSION_CHANGED');
      const result = parseLoginResult(response?.result, this.delivery);
      this.transport.session.replace({headers: this.delivery === 'token' ? {Authorization: `Bearer ${result.credential}`} : {}});
      return {account: result.account, expiresAtMs: result.expiresAtMs};
    });
  }

  async refresh(options) {
    return this.#exclusive(async () => {
      const response = await this.transport.request(SESSION_ROUTES.refresh, {}, options);
      return parseExpiryResult(response?.result);
    });
  }

  async logout(options) {
    return this.#exclusive(async () => {
      const revision = this.transport.session.snapshot().revision;
      try {
        const response = await this.transport.request(SESSION_ROUTES.logout, {}, options);
        return parseLogoutResult(response?.result);
      } finally {
        // A lost response is not confirmed revocation, but stops local authenticated work.
        if (this.transport.session.snapshot().revision === revision) this.transport.session.close();
      }
    });
  }

  async #exclusive(work) {
    if (this.#busy) throw new ApiError('SESSION_BUSY');
    this.#busy = true;
    try { return await work(); }
    finally { this.#busy = false; }
  }
}
