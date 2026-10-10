import {createHash} from 'node:crypto';

// Both session lookup and a data-permission snapshot use account a / session s.
export const sessionColumns = `a.id account_id,a.enabled,a.role account_role,a.auth_revision account_revision,
  s.id session_id,s.auth_revision session_revision,s.expires_at_ms,s.revoked`;

export function sessionFrom(row) {
  if (!row || !row.session_id) return null;
  return {
    accountId: row.account_id,
    accountRole: row.account_role,
    accountEnabled: row.enabled === 1,
    accountRevision: row.account_revision,
    sessionId: row.session_id,
    sessionRevision: row.session_revision,
    expiresAtMs: row.expires_at_ms,
    revoked: row.revoked === 1,
  };
}

export class SqliteSessionReader {
  constructor({database}) {
    this.find = database.prepare(`SELECT ${sessionColumns} FROM v2_sessions s
      JOIN v2_accounts a ON a.id=s.account_id WHERE s.token_hash=?`);
    this.byActor = database.prepare(`SELECT ${sessionColumns} FROM v2_sessions s
      JOIN v2_accounts a ON a.id=s.account_id WHERE s.id=? AND a.id=?`);
  }

  findByActor(actor) {
    return sessionFrom(this.byActor.get(actor.sessionId, actor.id));
  }

  findByCredential(credential) {
    const hash = createHash('sha256').update(credential).digest('hex');
    return sessionFrom(this.find.get(hash));
  }
}
