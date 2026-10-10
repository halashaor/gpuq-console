import {RegisterDirectory} from '../application/register-directory.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {ConfiguredDirectories} from '../infrastructure/configured-directories.mjs';
import {SqliteDirectoryRegistrations} from '../infrastructure/sqlite/directory-registrations.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createDirectoryRegistrationHandler} from '../api/directory-registration-handler.mjs';

export function assembleSqliteDirectoryRegistration({database, configuredDirectories, publicOrigin, clock = Date.now, reportError}) {
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createDirectoryRegistrationHandler({authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}), reportError,
    registerDirectory: new RegisterDirectory({registrations: new SqliteDirectoryRegistrations({database}),
      configuredSources: new ConfiguredDirectories(configuredDirectories), clock}),
  });
}
