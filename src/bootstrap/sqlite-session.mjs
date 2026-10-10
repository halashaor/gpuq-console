import {Login} from '../application/login.mjs';
import {SessionLifecycle} from '../application/session-lifecycle.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {Pbkdf2Passwords} from '../infrastructure/passwords.mjs';
import {SessionTokens} from '../infrastructure/session-tokens.mjs';
import {SqliteLoginAccounts, SqliteLoginAttempts, SqliteLoginSessions} from '../infrastructure/sqlite/login-repositories.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createSessionHandler} from '../api/session-handler.mjs';

/** One instance per state authority. Schema initialization is caller-owned. */
export function assembleSqliteSession({database, publicOrigin, clock = Date.now, reportError}) {
  const sessions = new SqliteLoginSessions({database});
  const login = new Login({
    accounts: new SqliteLoginAccounts({database}), attempts: new SqliteLoginAttempts({database}),
    passwords: new Pbkdf2Passwords(), tokens: new SessionTokens(), sessions, clock,
  });
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  const authenticate = createSessionAuthenticator({authenticateSession, publicOrigin});
  return createSessionHandler({login, lifecycle: new SessionLifecycle({sessions, clock}), authenticate, publicOrigin, reportError});
}
