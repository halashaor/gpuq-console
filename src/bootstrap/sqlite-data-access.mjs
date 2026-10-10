import {GetDataAccess, SetDataReaders} from '../application/data-access.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {SqliteDataAccess} from '../infrastructure/sqlite/data-access.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createDataAccessHandler} from '../api/data-access-handler.mjs';

export function assembleSqliteDataAccess({database, publicOrigin, clock = Date.now, reportError}) {
  const access = new SqliteDataAccess({database});
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createDataAccessHandler({authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}),
    getAccess: new GetDataAccess({access, clock}), setReaders: new SetDataReaders({access, clock}), reportError});
}
