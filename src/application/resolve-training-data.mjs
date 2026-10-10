import {ResolveDataRead} from './resolve-data-read.mjs';
import {containerPathFor} from '../domain/data-source.mjs';
import {ApplicationError} from '../domain/errors.mjs';

/** Observe existing reads only. No cache preparation, transfer or mount lease. */
export class ResolveTrainingData {
  constructor({access, sources}) {
    this.access = access;
    this.read = new ResolveDataRead({access, sources});
  }

  async requireAccess(actor, {machineId, sources}) {
    for (const source of sources) await this.access.requireRead(actor, {machineId, source});
  }

  async execute(actor, {machineId, sources}) {
    const paths = sources.map(containerPathFor);
    if (new Set(paths).size !== paths.length) throw new ApplicationError('TRAINING_DATA_PATH_CONFLICT');
    const request = {machineId, sources};
    await this.requireAccess(actor, request);
    const reads = [];
    try {
      for (const source of sources) {
        const read = await this.read.execute(actor, {machineId, source});
        if (read.availability !== 'available') throw new ApplicationError('TRAINING_DATA_UNAVAILABLE');
        reads.push(read);
      }
    } finally {await this.requireAccess(actor, request);}
    return reads;
  }
}
