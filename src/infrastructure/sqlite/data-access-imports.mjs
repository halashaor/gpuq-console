import {createHash} from 'node:crypto';
import {transaction, readTransaction} from './transaction.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {replaceDataReaders} from './data-access.mjs';
import {requireAdministrator} from '../../domain/account-policy.mjs';
import {planDataAccessImport} from '../../domain/data-access-import.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export function createDataAccessImportSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_data_access_imports (
    request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES v2_accounts(id),
    resource_id TEXT NOT NULL REFERENCES v2_data_resources(id), plan_id TEXT NOT NULL,
    plan_json TEXT NOT NULL, result_json TEXT NOT NULL
  )`));
}

export class SqliteDataAccessImports {
  constructor({database}) {this.database = database; this.sessions = new SqliteSessionReader({database});}
  authorize(actor, now) {requireAdministrator(actor, this.sessions.findByActor(actor), now);}

  #resource(resourceId) {
    const db = this.database;
    const row = db.prepare('SELECT * FROM v2_data_resources WHERE id=?').get(resourceId);
    if (!row) throw new ApplicationError('DATA_RESOURCE_NOT_FOUND');
    if (row.kind !== 'dataset') throw new ApplicationError('MANAGED_RESOURCE_REQUIRED');
    return {resourceId, datasetId: row.source_id, version: row.version, ownerId: row.owner_id,
      visibility: row.visibility, revision: row.acl_revision,
      readers: db.prepare('SELECT account_id FROM v2_data_readers WHERE resource_id=? ORDER BY account_id').all(resourceId).map(row => row.account_id),
      bindings: db.prepare('SELECT machine_id,storage_kind FROM v2_managed_bindings WHERE resource_id=? ORDER BY machine_id,storage_kind')
        .all(resourceId).map(row => ({machineId: row.machine_id, kind: row.storage_kind})),
    };
  }

  describe(actor, resourceId, now) {
    return readTransaction(this.database, () => {this.authorize(actor, now); return this.#resource(resourceId);});
  }

  #plan(resourceId, observations, accountMapping) {
    const resource = this.#resource(resourceId);
    const knownAccountIds = this.database.prepare('SELECT id FROM v2_accounts').all().map(row => row.id);
    const plan = planDataAccessImport({resource, observations, accountMapping, knownAccountIds});
    if (plan.state === 'blocked') return plan;
    return {...plan, planId: createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
  }

  plan(actor, resourceId, observations, accountMapping, now) {
    return readTransaction(this.database, () => {
      this.authorize(actor, now);
      return this.#plan(resourceId, observations, accountMapping);
    });
  }

  #storedReceipt(actor, requestId) {
    const row = this.database.prepare('SELECT * FROM v2_data_access_imports WHERE request_id=?').get(requestId);
    if (!row) return null;
    if (row.actor_id !== actor.id) throw new ApplicationError('IMPORT_REQUEST_CONFLICT');
    return row;
  }

  #receipt(actor, command) {
    const row = this.#storedReceipt(actor, command.requestId);
    if (!row) return null;
    if (row.resource_id !== command.resourceId || row.plan_id !== command.planId) {
      throw new ApplicationError('IMPORT_REQUEST_CONFLICT');
    }
    return JSON.parse(row.result_json);
  }

  receipt(actor, command, now) {
    return readTransaction(this.database, () => {
      this.authorize(actor, now);
      const row = this.#storedReceipt(actor, command.requestId);
      return row ? JSON.parse(row.result_json) : null;
    });
  }

  receiptForCommand(actor, command, now) {
    return readTransaction(this.database, () => {this.authorize(actor, now); return this.#receipt(actor, command);});
  }

  apply(actor, command, observations, accountMapping, now) {
    const db = this.database;
    return transaction(db, () => {
      this.authorize(actor, now);
      const prior = this.#receipt(actor, command);
      if (prior) return prior;
      const plan = this.#plan(command.resourceId, observations, accountMapping);
      if (plan.state !== 'proposed' || plan.planId !== command.planId) throw new ApplicationError('IMPORT_PLAN_CHANGED');
      replaceDataReaders(db, command.resourceId, plan.readers);
      const result = {requestId: command.requestId, resourceId: command.resourceId, state: 'imported', aclRevision: plan.expectedRevision + 1};
      db.prepare('INSERT INTO v2_data_access_imports(request_id,actor_id,resource_id,plan_id,plan_json,result_json) VALUES(?,?,?,?,?,?)')
        .run(command.requestId, actor.id, command.resourceId, command.planId, JSON.stringify(plan), JSON.stringify(result));
      return result;
    });
  }
}
