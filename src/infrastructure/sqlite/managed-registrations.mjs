import {randomUUID} from 'node:crypto';
import {transaction} from './transaction.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireAdministrator} from '../../domain/account-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export function createManagedRegistrationSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_managed_bindings (
    resource_id TEXT NOT NULL REFERENCES v2_data_resources(id),
    machine_id TEXT NOT NULL REFERENCES v2_machines(id),
    storage_kind TEXT NOT NULL CHECK(storage_kind IN ('warehouse','cache')),
    PRIMARY KEY(resource_id,machine_id,storage_kind)
  )`));
}

export class SqliteManagedRegistrations {
  constructor({database}) {this.database = database; this.sessions = new SqliteSessionReader({database});}
  authorize(actor, now) {requireAdministrator(actor, this.sessions.findByActor(actor), now);}

  register(actor, request, metadata, now) {
    const db = this.database, {machineId, source} = request;
    return transaction(db, () => {
      this.authorize(actor, now);
      if (!db.prepare('SELECT 1 FROM v2_machines WHERE id=?').get(machineId)) throw new ApplicationError('MACHINE_NOT_FOUND');
      if (!db.prepare('SELECT 1 FROM v2_accounts WHERE id=?').get(metadata.ownerId)) throw new ApplicationError('ACCOUNT_NOT_FOUND');
      const existing = db.prepare("SELECT id,owner_id,visibility FROM v2_data_resources WHERE kind='dataset' AND source_id=? AND version=?")
        .get(source.datasetId, source.version);
      const resourceId = existing?.id ?? randomUUID();
      if (existing) {
        if (existing.owner_id !== metadata.ownerId || existing.visibility !== metadata.visibility) throw new ApplicationError('SOURCE_REGISTRATION_CONFLICT');
      } else {
        db.prepare("INSERT INTO v2_data_resources(id,kind,source_id,version,visibility,owner_id) VALUES(?,'dataset',?,?,?,?)")
          .run(resourceId, source.datasetId, source.version, metadata.visibility, metadata.ownerId);
      }
      db.prepare('INSERT INTO v2_managed_bindings(resource_id,machine_id,storage_kind) VALUES(?,?,?) ON CONFLICT DO NOTHING')
        .run(resourceId, machineId, source.kind);
      // No host path or readiness snapshot is persisted. Reads inspect the node again.
      return {resourceId, machineId, source: {...source}, registered: true};
    });
  }
}
