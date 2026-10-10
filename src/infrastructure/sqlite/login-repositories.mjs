import {transaction} from './transaction.mjs';

const credentialsQuery = `SELECT a.id,a.username,a.display_name,a.role,a.enabled,a.auth_revision,
  c.salt,c.hash,c.iterations,c.revision credential_revision
  FROM v2_accounts a JOIN v2_credentials c ON c.account_id=a.id`;
function profile(row) {
  return {id: row.id, username: row.username, displayName: row.display_name, role: row.role};
}

export class SqliteLoginAccounts {
  constructor({database}) {
    this.lookup = database.prepare(credentialsQuery + ' WHERE a.username=?');
  }

  findCredentials(username) {
    const row = this.lookup.get(username);
    if (!row) return null;
    return {
      ...profile(row),
      enabled: row.enabled === 1,
      authRevision: row.auth_revision,
      credentialRevision: row.credential_revision,
      password: {salt: row.salt, hash: row.hash, iterations: row.iterations},
    };
  }
}

export class SqliteLoginAttempts {
  constructor({database}) {
    this.database = database;
  }

  find(username) {
    const row = this.database.prepare('SELECT failures,until_ms FROM v2_login_attempts WHERE username=?').get(username);
    return row ? {failures: row.failures, untilMs: row.until_ms} : null;
  }
  recordFailure(username, now, windowMs) {
    transaction(this.database, () => {
      this.database.prepare('DELETE FROM v2_login_attempts WHERE until_ms<=?').run(now);
      this.database.prepare(`INSERT INTO v2_login_attempts VALUES(?,1,?)
        ON CONFLICT(username) DO UPDATE SET failures=failures+1`).run(username, now + windowMs);
    });
  }
}

export class SqliteLoginSessions {
  constructor({database}) {
    this.database = database;
  }

  // Password verification awaits; recheck identity atomically with session issuance.
  issue({account, token, now, policy}) {
    const db = this.database;
    return transaction(db, () => {
      const current = db.prepare(credentialsQuery + ' WHERE a.id=?').get(account.id);
      if (!current || !current.enabled || current.username !== account.username
        || current.auth_revision !== account.authRevision
        || current.credential_revision !== account.credentialRevision) {
        return {kind: 'changed'};
      }
      db.prepare('DELETE FROM v2_sessions WHERE expires_at_ms<=? OR revoked=1').run(now);
      const counts = db.prepare('SELECT count(*) total,coalesce(sum(account_id=?),0) owner FROM v2_sessions').get(account.id);
      if (counts.owner >= policy.perAccount || counts.total >= policy.total) return {kind: 'limit'};
      const expiresAtMs = now + policy.idleMs;
      db.prepare(`INSERT INTO v2_sessions(id,token_hash,account_id,auth_revision,expires_at_ms,created_at_ms,touched_at_ms)
        VALUES(?,?,?,?,?,?,?)`).run(token.id, token.hash, account.id, current.auth_revision, expiresAtMs, now, now);
      db.prepare('DELETE FROM v2_login_attempts WHERE username=?').run(account.username);
      return {kind: 'issued', account: profile(current), expiresAtMs};
    });
  }

  refresh(actor, now, policy) {
    const db = this.database;
    return transaction(db, () => {
      const row = db.prepare(`SELECT s.expires_at_ms,s.touched_at_ms FROM v2_sessions s
        JOIN v2_accounts a ON a.id=s.account_id WHERE s.id=? AND s.account_id=? AND s.revoked=0
        AND a.enabled=1 AND s.auth_revision=a.auth_revision AND s.expires_at_ms>?`).get(actor.sessionId, actor.id, now);
      if (!row) return null;
      if (now - row.touched_at_ms < policy.touchMs) return {expiresAtMs: row.expires_at_ms};
      const expiresAtMs = now + policy.idleMs;
      db.prepare('UPDATE v2_sessions SET touched_at_ms=?,expires_at_ms=? WHERE id=?').run(now, expiresAtMs, actor.sessionId);
      return {expiresAtMs};
    });
  }

  revoke(actor) {
    this.database.prepare('UPDATE v2_sessions SET revoked=1 WHERE id=? AND account_id=?').run(actor.sessionId, actor.id);
  }
}
