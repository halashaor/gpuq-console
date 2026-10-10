import {transaction} from './transaction.mjs';
import {sessionColumns, sessionFrom} from './session-reader.mjs';
import {requireAccountChange, requireAccountRead} from '../../domain/account-policy.mjs';

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
