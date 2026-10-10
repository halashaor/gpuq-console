import {randomUUID} from 'node:crypto';
import {transaction, readTransaction} from './transaction.mjs';
import {SqliteComputeClaims} from './compute-claims.mjs';
import {SqliteSessionReader} from './session-reader.mjs';
import {requireActiveSession} from '../../domain/session-policy.mjs';
import {ApplicationError} from '../../domain/errors.mjs';
import {SqliteTaskAuthority} from './task-authority.mjs';
import {requireTaskPlacement} from '../../domain/task-placement.mjs';

export function createTrainingDispatchSchema(database) {
  transaction(database, () => database.exec(`CREATE TABLE v2_training_dispatches (
    dispatch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES v2_compute_claims(job_id),
    state TEXT NOT NULL CHECK(state='PREPARED'), created_at_ms INTEGER NOT NULL
  )`));
}

const receipt = row => ({dispatchId: row.dispatch_id, jobId: row.job_id, machineId: row.machine_id,
  gpuCount: row.gpu_count, state: row.state, createdAtMs: row.created_at_ms});

/** Durable dispatch intent only: no network, GPU lease, worker or user code. */
export class SqliteTrainingDispatches {
  constructor({database}) {
    this.database = database;
    this.sessions = new SqliteSessionReader({database});
    this.claims = new SqliteComputeClaims({database});
  }

  #authorize(actor, jobId, now) {
    requireActiveSession(this.sessions.findByActor(actor), now);
    const job = this.database.prepare('SELECT account_id FROM v2_training_requests WHERE job_id=?').get(jobId);
    if (!job || job.account_id !== actor.id) throw new ApplicationError('FORBIDDEN');
  }

  #find(jobId) {
    return this.database.prepare(`SELECT d.*,c.machine_id,c.gpu_count FROM v2_training_dispatches d
      JOIN v2_compute_claims c ON c.job_id=d.job_id WHERE d.job_id=?`).get(jobId);
  }

  prepare(actor, command, now) {
    return transaction(this.database, () => {
      this.#authorize(actor, command.jobId, now);
      return this.#prepare(command, now, () => this.claims.claimWithinTransaction(actor, command, now, {requireCurrentAccess: true}));
    });
  }

  prepareForTask(jobId, selection, now) {
    return transaction(this.database, () => {
      const context = new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId);
      requireTaskPlacement(context.submission, selection);
      const command = {jobId, machineId: selection.machineId, gpuCount: selection.gpuCount};
      return this.#prepare(command, now, () => this.claims.claimTaskWithinTransaction(jobId, selection, now));
    });
  }

  #prepare(command, now, reserve) {
      const existing = this.#find(command.jobId);
      if (existing) {
        if (existing.machine_id !== command.machineId || existing.gpu_count !== command.gpuCount) {
          throw new ApplicationError('TRAINING_DISPATCH_CONFLICT');
        }
        return receipt(existing);
      }
      const claim = reserve();
      if (claim.state !== 'HELD') throw new ApplicationError('COMPUTE_CLAIM_NOT_HELD');
      this.database.prepare("INSERT INTO v2_training_dispatches VALUES(?,?,'PREPARED',?)")
        .run(randomUUID(), command.jobId, now);
      return receipt(this.#find(command.jobId));
  }

  getForTask(jobId) {
    return readTransaction(this.database, () => {
      new SqliteTaskAuthority({database: this.database}).contextWithinTransaction(jobId);
      const row = this.#find(jobId);
      return row ? receipt(row) : null;
    });
  }

  get(actor, jobId, now) {
    return readTransaction(this.database, () => {
      this.#authorize(actor, jobId, now);
      const row = this.#find(jobId);
      return row ? receipt(row) : null;
    });
  }
}
