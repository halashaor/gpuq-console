import {LocalSourceReader} from '../infrastructure/local-source-reader.mjs';
import {ManagedSourceReader} from '../infrastructure/managed-source-reader.mjs';
import {NodeSourceReader} from '../infrastructure/node-source-reader.mjs';

/** Real node composition: managed readiness never comes from a cached DB flag. */
export function assembleNodeSourceReader({machineId, directoryCatalog, managedRoots, python, timeoutMs}) {
  return new NodeSourceReader({
    directories: new LocalSourceReader({machineId, catalog: directoryCatalog}),
    managed: new ManagedSourceReader({machineId, roots: managedRoots, python, timeoutMs}),
  });
}
