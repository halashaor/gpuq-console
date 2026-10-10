import {openSync, closeSync, fstatSync, constants} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createClientCredentialSchema, SqliteClientCredentials} from './sqlite/client-credentials.mjs';

/** Explicit local file creation. Parent directory is supplied/owned by the CLI. */
export function openClientCredentials(path) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Credential file must be private (0600)');
  } finally {
    closeSync(fd);
  }
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON');
    createClientCredentialSchema(database);
    return {credentials: new SqliteClientCredentials({database}), close: () => database.close()};
  } catch (error) {
    database.close();
    throw error;
  }
}
