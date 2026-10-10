import {ImportDataAccess} from '../application/import-data-access.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {SqliteDataAccessImports} from '../infrastructure/sqlite/data-access-imports.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createDataAccessImportHandler} from '../api/data-access-import-handler.mjs';

export function assembleSqliteDataAccessImport({database, legacyAccess, accountMapping, publicOrigin, clock = Date.now, reportError}) {
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createDataAccessImportHandler({authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}), reportError,
    imports: new ImportDataAccess({imports: new SqliteDataAccessImports({database}), legacyAccess, accountMapping, clock}),
  });
}
