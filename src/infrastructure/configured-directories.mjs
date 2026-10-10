import {isAbsolute} from 'node:path';

/** Operator-owned node configuration, never paths supplied by an API caller. */
export class ConfiguredDirectories {
  #sources = new Map();

  constructor(entries) {
    for (const entry of entries) {
      const {machineId, sourceId, hostPath, visibility, ownerId} = entry;
      const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
      if (typeof machineId !== 'string' || !id.test(machineId) || typeof sourceId !== 'string' || !id.test(sourceId)
        || typeof hostPath !== 'string' || !isAbsolute(hostPath) || hostPath.includes('\0')
        || !['private', 'shared'].includes(visibility) || (ownerId !== null && (typeof ownerId !== 'string' || !ownerId))
        || (visibility === 'private' && ownerId === null)) throw new Error('Invalid configured directory');
      const key = `${machineId}/${sourceId}`;
      if (this.#sources.has(key)) throw new Error('Duplicate configured directory');
      this.#sources.set(key, {hostPath, visibility, ownerId});
    }
  }

  find({machineId, sourceId}) {
    const source = this.#sources.get(`${machineId}/${sourceId}`);
    return source ? {...source} : null;
  }
}
