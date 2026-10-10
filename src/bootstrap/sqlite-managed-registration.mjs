import {RegisterManagedSource} from '../application/register-managed-source.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {ConfiguredManagedVersions} from '../infrastructure/configured-managed-versions.mjs';
import {SqliteManagedRegistrations} from '../infrastructure/sqlite/managed-registrations.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createManagedRegistrationHandler} from '../api/managed-registration-handler.mjs';

export function assembleSqliteManagedRegistration({database, configuredVersions, sources, publicOrigin, clock = Date.now, reportError}) {
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createManagedRegistrationHandler({authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}), reportError,
    registerSource: new RegisterManagedSource({registrations: new SqliteManagedRegistrations({database}),
      configuredVersions: new ConfiguredManagedVersions(configuredVersions), sources, clock}),
  });
}
