import {transaction, readTransaction} from './transaction.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireActiveSession} from '../../domain/session-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export function createProjectRegistrationSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_project_instances (
    project_id TEXT NOT NULL REFERENCES v2_projects(id), machine_id TEXT NOT NULL REFERENCES v2_machines(id),
    project_slug TEXT NOT NULL, project_uuid TEXT NOT NULL, generation TEXT NOT NULL,
    PRIMARY KEY(project_id,machine_id), UNIQUE(machine_id,project_uuid,generation)
  )`));
}

export class SqliteProjectRegistrations {
  constructor({database}) {this.database = database; this.sessions = new SqliteSessionReader({database});}
  #authorize(actor, request, now) {
    const db = this.database, session = this.sessions.findByActor(actor);
    requireActiveSession(session, now);
    const machine = db.prepare('SELECT enabled FROM v2_machines WHERE id=?').get(request.machineId);
    const granted = db.prepare('SELECT 1 FROM v2_machine_grants WHERE account_id=? AND machine_id=?').get(actor.id, request.machineId);
    if (!machine || !machine.enabled || (session.accountRole !== 'admin' && !granted)) throw new ApplicationError('FORBIDDEN');
    const project = db.prepare('SELECT owner_id,archived FROM v2_projects WHERE id=?').get(request.projectId);
    if (project && project.owner_id !== actor.id) throw new ApplicationError('FORBIDDEN');
    if (project?.archived) throw new ApplicationError('PROJECT_ARCHIVED');
  }
  authorize(actor, request, now) {
    return readTransaction(this.database, () => this.#authorize(actor, request, now));
  }
  register(actor, request, observed, now) {
    const db = this.database;
    return transaction(db, () => {
      this.#authorize(actor, request, now);
      const instance = db.prepare('SELECT * FROM v2_project_instances WHERE project_id=? AND machine_id=?').get(request.projectId, request.machineId);
      const alias = db.prepare('SELECT project_id FROM v2_project_instances WHERE machine_id=? AND project_uuid=? AND generation=?')
        .get(request.machineId, observed.projectUUID, observed.generation);
      if ((alias && alias.project_id !== request.projectId) || (instance && (instance.project_uuid !== observed.projectUUID
        || instance.generation !== observed.generation || instance.project_slug !== request.project))) throw new ApplicationError('PROJECT_INSTANCE_CONFLICT');
      db.prepare('INSERT INTO v2_projects(id,owner_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(request.projectId, actor.id);
      db.prepare('INSERT INTO v2_project_instances VALUES(?,?,?,?,?) ON CONFLICT(project_id,machine_id) DO NOTHING')
        .run(request.projectId, request.machineId, request.project, observed.projectUUID, observed.generation);
      db.prepare('INSERT INTO v2_project_releases VALUES(?,?) ON CONFLICT DO NOTHING').run(request.projectId, request.release);
      db.prepare('INSERT INTO v2_release_locations VALUES(?,?,?) ON CONFLICT DO NOTHING').run(request.projectId, request.release, request.machineId);
      return {projectId: request.projectId, machineId: request.machineId, release: request.release,
        projectUUID: observed.projectUUID, generation: observed.generation, registered: true, runtimeVerified: false};
    });
  }
}
