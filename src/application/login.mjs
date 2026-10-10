import {ApplicationError} from '../domain/errors.mjs';
import {LOGIN_POLICY, SESSION_POLICY} from '../domain/session-policy.mjs';

/** One instance per authority process; shared by browser and CLI routes. */
export class Login {
  #active = new Set();

  constructor({accounts, passwords, attempts, sessions, tokens, clock = Date.now}) {
    this.accounts = accounts;
    this.passwords = passwords;
    this.attempts = attempts;
    this.sessions = sessions;
    this.tokens = tokens;
    this.clock = clock;
  }
  async execute({username, password}) {
    if (this.#active.has(username) || this.#active.size >= LOGIN_POLICY.concurrent) {
      throw new ApplicationError('LOGIN_BUSY');
    }
    this.#active.add(username);
    try {
      const recent = await this.attempts.find(username);
      if (recent && recent.untilMs > this.clock() && recent.failures >= LOGIN_POLICY.failures) {
        throw new ApplicationError('LOGIN_RATE_LIMIT');
      }
      const account = await this.accounts.findCredentials(username);
      const valid = await this.passwords.verify(password, account?.password ?? null);
      if (!account?.enabled || !valid) {
        await this.attempts.recordFailure(username, this.clock(), LOGIN_POLICY.windowMs);
        throw new ApplicationError('INVALID_CREDENTIALS');
      }
      const token = this.tokens.create();
      const result = await this.sessions.issue({account, token, now: this.clock(), policy: SESSION_POLICY});
      if (result.kind === 'changed') throw new ApplicationError('AUTHENTICATION_CHANGED');
      if (result.kind === 'limit') throw new ApplicationError('SESSION_LIMIT');
      return {
        credential: token.credential,
        actor: {id: result.account.id, sessionId: token.id},
        account: result.account,
        expiresAtMs: result.expiresAtMs,
      };
    } finally {
      this.#active.delete(username);
    }
  }
}
