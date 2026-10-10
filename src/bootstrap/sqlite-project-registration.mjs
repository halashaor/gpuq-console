import {RegisterProjectRelease} from '../application/register-project-release.mjs';
import {GetProjectRegistration} from '../application/get-project-registration.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {SqliteProjectRegistrations} from '../infrastructure/sqlite/project-registrations.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createProjectRegistrationHandler} from '../api/project-registration-handler.mjs';

export function assembleSqliteProjectRegistration({database, projects, publicOrigin, clock = Date.now, reportError}) {
  const registrations = new SqliteProjectRegistrations({database});
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createProjectRegistrationHandler({authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}), reportError,
    registerProject: new RegisterProjectRelease({registrations, projects, clock}), getRegistration: new GetProjectRegistration({registrations, clock})});
}
