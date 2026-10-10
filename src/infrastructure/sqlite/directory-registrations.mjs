import {randomUUID} from 'node:crypto';
import {transaction} from './transaction.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireAdministrator} from '../../domain/account-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export class SqliteDirectoryRegistrations {
  constructor({database}) {this.database = database; this.sessions = new SqliteSessionReader({database});}

  authorize(actor, now) {
    requireAdministrator(actor, this.sessions.findByActor(actor), now);
  }

  register(actor, {machineId, sourceId}, source, now) {
    const db = this.database;
    return transaction(db, () => {
      this.authorize(actor, now);
      if (!db.prepare('SELECT 1 FROM v2_machines WHERE id=?').get(machineId)) throw new ApplicationError('MACHINE_NOT_FOUND');
      if (source.ownerId !== null && !db.prepare('SELECT 1 FROM v2_accounts WHERE id=?').get(source.ownerId)) throw new ApplicationError('ACCOUNT_NOT_FOUND');
      const existing = db.prepare(`SELECT r.id,r.visibility,r.owner_id,b.host_path FROM v2_data_resources r
        LEFT JOIN v2_source_bindings b ON b.resource_id=r.id AND b.machine_id=r.machine_id AND b.storage_kind='directory'
        WHERE r.kind='directory' AND r.machine_id=? AND r.source_id=?`).get(machineId, sourceId);
      let resourceId;
      if (existing) {
        if (existing.visibility !== source.visibility || existing.owner_id !== source.ownerId || existing.host_path !== source.hostPath) {
          throw new ApplicationError('SOURCE_REGISTRATION_CONFLICT');
        }
        resourceId = existing.id;
      } else {
        resourceId = randomUUID();
        db.prepare(`INSERT INTO v2_data_resources(id,kind,machine_id,source_id,version,visibility,owner_id)
          VALUES(?,'directory',?,?,NULL,?,?)`).run(resourceId, machineId, sourceId, source.visibility, source.ownerId);
        // Binding is metadata only: no READY proof, mount, copy, scan or mkdir.
        db.prepare(`INSERT INTO v2_source_bindings(resource_id,machine_id,storage_kind,host_path,ready)
          VALUES(?,?,'directory',?,0)`).run(resourceId, machineId, source.hostPath);
      }
      return {resourceId, machineId, sourceId, registered: true};
    });
  }
}
