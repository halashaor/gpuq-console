import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {DataReadAccess} from '../application/data-read-access.mjs';
import {SqliteDataAuthority,SqliteSourceCatalog} from '../infrastructure/sqlite/data-read-repositories.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {assembleDataRead} from './data-read.mjs';
import {LocalSourceReader} from '../infrastructure/local-source-reader.mjs';

// Node-local composition. A VPS must supply a remote source adapter instead.
// Database ownership/migrations stay with the caller. This only composes reads.
export function assembleLocalSqliteDataRead({database,machineId,publicOrigin,clock=Date.now,reportError}){
  const catalog=new SqliteSourceCatalog({database});
  const sources=new LocalSourceReader({machineId,catalog});
  return assembleSqliteDataRead({database,sources,publicOrigin,clock,reportError});
}

/** Coordinator composition uses a node reader, not the VPS filesystem. */
export function assembleSqliteDataRead({database,sources,publicOrigin,clock=Date.now,reportError}){
  const sessions=new SqliteSessionReader({database});
  const authority=new SqliteDataAuthority({database});
  const authenticateSession=new AuthenticateSession({sessions,clock});
  const authenticate=createSessionAuthenticator({authenticateSession,publicOrigin});
  const access=new DataReadAccess({authority,clock});
  return assembleDataRead({authenticate,access,sources,reportError});
}
