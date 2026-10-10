import {transaction} from './transaction.mjs';
import {sessionColumns, sessionFrom} from './session-reader.mjs';
import {requireComputePolicyAccess, requireComputePolicyChange} from '../../domain/compute-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export class SqliteComputePolicies {
  constructor({database}) {this.database = database;}

  #facts(actor, accountId) {
    const row = this.database.prepare(`SELECT ${sessionColumns},t.id target_id,t.role target_role,
      p.revision,p.total_cards FROM v2_sessions s JOIN v2_accounts a ON a.id=s.account_id
      LEFT JOIN v2_accounts t ON t.id=? LEFT JOIN v2_compute_policies p ON p.account_id=t.id
      WHERE s.id=? AND a.id=?`).get(accountId, actor.sessionId, actor.id);
    return {session: sessionFrom(row), target: row?.target_id ? {id: row.target_id, role: row.target_role} : null,
      revision: row?.revision ?? 0, totalCards: row?.total_cards ?? 0};
  }

  #read(accountId, facts) {
    const rows = this.database.prepare('SELECT machine_id,max_cards FROM v2_machine_grants WHERE account_id=? ORDER BY machine_id').all(accountId);
    if (rows.some(row => row.max_cards === null)) throw new ApplicationError('POLICY_UNINITIALIZED');
    return {accountId, revision: facts.revision, totalCards: facts.totalCards,
      limits: rows.map(row => ({machineId: row.machine_id, maxCards: row.max_cards}))};
  }

  get(actor, accountId, now) {
    // A read transaction keeps authorization and all policy rows in one snapshot.
    const db = this.database;
    db.exec('BEGIN');
    try {
      const facts = this.#facts(actor, accountId);
      requireComputePolicyAccess(actor, facts, now);
      const result = this.#read(accountId, facts);
      db.exec('COMMIT');
      return result;
    } catch (error) {db.exec('ROLLBACK'); throw error;}
  }

  set(actor, command, now) {
    const db = this.database;
    return transaction(db, () => {
      const facts = this.#facts(actor, command.accountId);
      facts.machines = db.prepare('SELECT id,cards FROM v2_machines').all();
      requireComputePolicyChange(actor, facts, command, now);
      db.prepare('DELETE FROM v2_machine_grants WHERE account_id=?').run(command.accountId);
      for (const limit of command.limits) {
        db.prepare('INSERT INTO v2_machine_grants(account_id,machine_id,max_cards) VALUES(?,?,?)')
          .run(command.accountId, limit.machineId, limit.maxCards);
      }
      db.prepare(`INSERT INTO v2_compute_policies(account_id,total_cards,revision) VALUES(?,?,?)
        ON CONFLICT(account_id) DO UPDATE SET total_cards=excluded.total_cards,revision=excluded.revision`)
        .run(command.accountId, command.totalCards, facts.revision + 1);
      return this.#read(command.accountId, {revision: facts.revision + 1, totalCards: command.totalCards});
    });
  }
}
