import {ChangeAccount} from '../application/change-account.mjs';
import {GetAccount} from '../application/get-account.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {SqliteAccounts} from '../infrastructure/sqlite/accounts.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createAccountHandler} from '../api/account-handler.mjs';

export function assembleSqliteAccount({database, publicOrigin, clock = Date.now, reportError}) {
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  const accounts = new SqliteAccounts({database});
  return createAccountHandler({
    authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}),
    changeAccount: new ChangeAccount({accounts, clock}), getAccount: new GetAccount({accounts, clock}), reportError,
  });
}
