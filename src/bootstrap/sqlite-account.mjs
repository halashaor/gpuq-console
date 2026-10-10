import {ChangeAccount} from '../application/change-account.mjs';
import {CreateAccount} from '../application/create-account.mjs';
import {GetAccount} from '../application/get-account.mjs';
import {ResetPassword} from '../application/reset-password.mjs';
import {Pbkdf2Passwords} from '../infrastructure/passwords.mjs';
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
    createAccount: new CreateAccount({accounts, passwords: new Pbkdf2Passwords(), clock}),
    resetPassword: new ResetPassword({accounts, passwords: new Pbkdf2Passwords(), clock}),
    changeAccount: new ChangeAccount({accounts, clock}), getAccount: new GetAccount({accounts, clock}), reportError,
  });
}
