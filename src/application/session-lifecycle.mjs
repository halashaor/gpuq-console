import {ApplicationError} from '../domain/errors.mjs';
import {SESSION_POLICY} from '../domain/session-policy.mjs';

export class SessionLifecycle {
  constructor({sessions, clock = Date.now}) {
    this.sessions = sessions;
    this.clock = clock;
  }

  async refresh(actor) {
    const result = await this.sessions.refresh(actor, this.clock(), SESSION_POLICY);
    if (!result) throw new ApplicationError('UNAUTHENTICATED');
    return result;
  }

  async current(actor) {
    const result = await this.sessions.current(actor, this.clock());
    if (!result) throw new ApplicationError('UNAUTHENTICATED');
    return result;
  }
  async logout(actor) {
    await this.sessions.revoke(actor);
  }
}
