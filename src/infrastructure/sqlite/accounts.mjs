import {transaction} from './transaction.mjs';
import {sessionColumns, sessionFrom} from './session-reader.mjs';
import {requireAccountChange, requireAccountRead, requirePasswordReset, requireAdministrator} from '../../domain/account-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

function accountFrom(row) {
  return row ? {id: row.id, role: row.role, enabled: row.enabled === 1, revision: row.auth_revision} : null;
}

export class SqliteAccounts {
  constructor({database}) {
    this.database = database;
  }

  #facts(actor, accountId) {
    const row = this.database.prepare(`SELECT ${sessionColumns},t.id target_id,t.role target_role,
      t.enabled target_enabled,t.auth_revision target_revision,
      (SELECT count(*) FROM v2_accounts WHERE role='admin' AND enabled=1 AND id<>?) other_admins
      FROM v2_sessions s JOIN v2_accounts a ON a.id=s.account_id
      LEFT JOIN v2_accounts t ON t.id=? WHERE s.id=? AND a.id=?`)
      .get(accountId, accountId, actor.sessionId, actor.id);
    return {
      session: sessionFrom(row), otherEnabledAdmins: row?.other_admins ?? 0,
      target: row?.target_id ? {id: row.target_id, role: row.target_role, enabled: row.target_enabled === 1, revision: row.target_revision} : null,
    };
  }

  get(actor, accountId, now) {
    const facts = this.#facts(actor, accountId);
    requireAccountRead(actor, facts, now);
    return facts.target;
  }

  list(actor, {after, limit}, now) {
    // Identity and this page are observed by one statement, without a write lock.
    const rows = this.database.prepare(`SELECT ${sessionColumns},t.id target_id,t.username,t.display_name,
      t.role target_role,t.enabled target_enabled,t.auth_revision target_revision
      FROM v2_sessions s JOIN v2_accounts a ON a.id=s.account_id
      LEFT JOIN (SELECT * FROM v2_accounts WHERE id>? ORDER BY id LIMIT ?) t ON 1
      WHERE s.id=? AND a.id=? ORDER BY t.id`).all(after ?? '', limit + 1, actor.sessionId, actor.id);
    requireAdministrator(actor, sessionFrom(rows[0]), now);
    const observed = rows.filter(row => row.target_id !== null);
    const accounts = observed.slice(0, limit).map(row => ({
      id: row.target_id, username: row.username, displayName: row.display_name,
      role: row.target_role, enabled: row.target_enabled === 1, revision: row.target_revision,
    }));
    return {accounts, nextCursor: observed.length > limit ? accounts.at(-1).id : null};
  }

  authorizeCreate(actor, now) {
    requireAdministrator(actor, this.#facts(actor, null).session, now);
  }

  create(actor, command, now) {
    const db = this.database;
    return transaction(db, () => {
      this.authorizeCreate(actor, now);
      if (db.prepare('SELECT 1 FROM v2_accounts WHERE id=?').get(command.accountId)) throw new ApplicationError('ACCOUNT_EXISTS');
      if (db.prepare('SELECT 1 FROM v2_accounts WHERE username=?').get(command.username)) throw new ApplicationError('USERNAME_EXISTS');
      db.prepare('INSERT INTO v2_accounts(id,username,display_name,role) VALUES(?,?,?,?)')
        .run(command.accountId, command.username, command.displayName, command.role);
      const {salt, hash, iterations} = command.password;
      db.prepare('INSERT INTO v2_credentials(account_id,salt,hash,iterations) VALUES(?,?,?,?)')
        .run(command.accountId, salt, hash, iterations);
      return accountFrom(db.prepare('SELECT * FROM v2_accounts WHERE id=?').get(command.accountId));
    });
  }

  authorizePasswordReset(actor, command, now) {
    requirePasswordReset(actor, this.#facts(actor, command.accountId), command, now);
  }

  resetPassword(actor, command, now) {
    const db = this.database;
    return transaction(db, () => {
      this.authorizePasswordReset(actor, command, now);
      const {salt, hash, iterations} = command.password;
      db.prepare(`INSERT INTO v2_credentials(account_id,salt,hash,iterations,revision) VALUES(?,?,?,?,0)
        ON CONFLICT(account_id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,
          iterations=excluded.iterations,revision=v2_credentials.revision+1`)
        .run(command.accountId, salt, hash, iterations);
      db.prepare('UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id=?').run(command.accountId);
      return accountFrom(db.prepare('SELECT * FROM v2_accounts WHERE id=?').get(command.accountId));
    });
  }

  change(actor, command, now) {
    const db = this.database;
    return transaction(db, () => {
      const facts = this.#facts(actor, command.accountId);
      requireAccountChange(actor, facts, command, now);
      const {target} = facts;
      if (command.kind === 'enabled' && target.enabled === command.enabled) return target;
      if (command.kind === 'role') {
        db.prepare('UPDATE v2_accounts SET role=?,auth_revision=auth_revision+1 WHERE id=?').run(command.role, command.accountId);
      } else {
        db.prepare('UPDATE v2_accounts SET enabled=?,auth_revision=auth_revision+1 WHERE id=?').run(Number(command.enabled), command.accountId);
      }
      return accountFrom(db.prepare('SELECT * FROM v2_accounts WHERE id=?').get(command.accountId));
    });
  }
}
