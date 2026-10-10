import {transaction, readTransaction} from './transaction.mjs';
import {sessionColumns, sessionFrom} from './session-reader.mjs';
import {requireDataAccessManagement, requireDataReadersChange} from '../../domain/data-access-policy.mjs';

export function createDataAccessSchema(database) {
  transaction(database, () => database.exec('ALTER TABLE v2_data_resources ADD COLUMN acl_revision INTEGER NOT NULL DEFAULT 0 CHECK(acl_revision>=0)'));
}

export class SqliteDataAccess {
  constructor({database}) {this.database = database;}

  #facts(actor, resourceId) {
    const row = this.database.prepare(`SELECT ${sessionColumns},r.id resource_id,r.visibility,r.owner_id,r.acl_revision
      FROM v2_sessions s JOIN v2_accounts a ON a.id=s.account_id
      LEFT JOIN v2_data_resources r ON r.id=? WHERE s.id=? AND a.id=?`).get(resourceId, actor.sessionId, actor.id);
    return {session: sessionFrom(row), resource: row?.resource_id
      ? {resourceId: row.resource_id, visibility: row.visibility, ownerId: row.owner_id, revision: row.acl_revision} : null};
  }

  #read(resource) {
    const rows = this.database.prepare('SELECT account_id FROM v2_data_readers WHERE resource_id=? ORDER BY account_id').all(resource.resourceId);
    return {...resource, readers: rows.map(row => row.account_id)};
  }

  get(actor, resourceId, now) {
    return readTransaction(this.database, () => {
      const facts = this.#facts(actor, resourceId);
      requireDataAccessManagement(actor, facts, now);
      return this.#read(facts.resource);
    });
  }

  setReaders(actor, command, now) {
    const db = this.database;
    return transaction(db, () => {
      const facts = this.#facts(actor, command.resourceId);
      // Authorization precedes recipient lookup. Recipients do not receive machine grants.
      requireDataAccessManagement(actor, facts, now);
      facts.knownReaders = command.readers.filter(id => db.prepare('SELECT 1 FROM v2_accounts WHERE id=?').get(id)).length;
      requireDataReadersChange(facts, command);
      db.prepare('DELETE FROM v2_data_readers WHERE resource_id=?').run(command.resourceId);
      for (const id of command.readers) db.prepare('INSERT INTO v2_data_readers(resource_id,account_id) VALUES(?,?)').run(command.resourceId, id);
      db.prepare('UPDATE v2_data_resources SET acl_revision=acl_revision+1 WHERE id=?').run(command.resourceId);
      return this.#read({...facts.resource, revision: facts.resource.revision + 1});
    });
  }
}
