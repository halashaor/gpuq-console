import {transaction, readTransaction} from './transaction.mjs';
import {SqliteTrainingRequests} from './training-requests.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireActiveSession} from '../../domain/session-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';

export function createTrainingQueueSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_training_queue (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE REFERENCES v2_training_requests(job_id),
    priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 4), queued_at_ms INTEGER NOT NULL
  ); CREATE INDEX v2_training_queue_order ON v2_training_queue(priority DESC,sequence ASC)`));
}

/** Durable order, not a second execution state machine. Dispatch records own preparation. */
export class SqliteTrainingQueue {
  constructor({database}) {
    this.database = database; this.requests = new SqliteTrainingRequests({database});
    this.sessions = new SqliteSessionReader({database});
  }

  enqueue(actor, input, now) {
    return transaction(this.database, () => {
      const request = this.requests.recordWithinTransaction(actor, input, now);
      let row = this.database.prepare('SELECT * FROM v2_training_queue WHERE job_id=?').get(request.jobId);
      if (!row) {
        this.database.prepare(`INSERT INTO v2_training_queue(job_id,priority,queued_at_ms)
          SELECT job_id,json_extract(payload_json,'$.scheduling.priority'),? FROM v2_training_requests WHERE job_id=?`).run(now, request.jobId);
        row = this.database.prepare('SELECT * FROM v2_training_queue WHERE job_id=?').get(request.jobId);
      }
      return {request, sequence: row.sequence, queuedAtMs: row.queued_at_ms};
    });
  }

  get(actor, jobId, now) {
    return readTransaction(this.database, () => {
      requireActiveSession(this.sessions.findByActor(actor), now);
      const job = this.database.prepare('SELECT account_id FROM v2_training_requests WHERE job_id=?').get(jobId);
      if (!job || job.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
      const row = this.database.prepare(`SELECT q.*,d.dispatch_id FROM v2_training_queue q
        LEFT JOIN v2_training_dispatches d ON d.job_id=q.job_id WHERE q.job_id=?`).get(jobId);
      return row ? {jobId, sequence: row.sequence, priority: row.priority, queuedAtMs: row.queued_at_ms,
        state: row.dispatch_id ? 'PREPARED' : 'QUEUED', dispatchId: row.dispatch_id ?? null} : null;
    });
  }

  /** Internal worker read, not a public cross-account listing. Cursor is priority + sequence. */
  pending({limit = 100, after = null} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (after !== null
      && (!Number.isInteger(after.priority) || after.priority < 0 || after.priority > 4
        || !Number.isSafeInteger(after.sequence) || after.sequence < 1))) throw new TypeError('Invalid queue page');
    return readTransaction(this.database, () => this.database.prepare(`
      SELECT q.sequence,q.priority,q.queued_at_ms,j.job_id,j.account_id FROM v2_training_queue q
      JOIN v2_training_requests j ON j.job_id=q.job_id
      LEFT JOIN v2_training_dispatches d ON d.job_id=q.job_id
      WHERE d.job_id IS NULL AND (? IS NULL OR q.priority<? OR (q.priority=? AND q.sequence>?))
      ORDER BY q.priority DESC,q.sequence ASC LIMIT ?`)
      .all(after?.priority ?? null, after?.priority ?? null, after?.priority ?? null, after?.sequence ?? null, limit)
      .map(row => ({jobId: row.job_id, accountId: row.account_id, priority: row.priority,
        sequence: row.sequence, queuedAtMs: row.queued_at_ms})));
  }
}
