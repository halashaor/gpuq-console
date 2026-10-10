import {parseDataReadRequest} from '../contracts/data-read.mjs';

const key = request => JSON.stringify([request.machineId, request.source.kind, request.source.datasetId, request.source.version]);

/** Metadata selected by the operator; registration requests cannot choose owners. */
export class ConfiguredManagedVersions {
  #versions = new Map();
  constructor(entries) {
    for (const entry of entries) {
      const request = parseDataReadRequest({machineId: entry.machineId, source: entry.source});
      if (request.source.kind === 'directory' || !['private', 'shared'].includes(entry.visibility)
        || typeof entry.ownerId !== 'string' || !entry.ownerId || entry.ownerId.length > 128 || this.#versions.has(key(request))) {
        throw new TypeError('Invalid managed version configuration');
      }
      this.#versions.set(key(request), {ownerId: entry.ownerId, visibility: entry.visibility});
    }
  }
  find(request) {
    const value = this.#versions.get(key(request));
    return value ? {...value} : null;
  }
}
