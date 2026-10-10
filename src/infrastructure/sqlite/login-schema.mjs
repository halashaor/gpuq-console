import {transaction} from './transaction.mjs';

/** Explicit next schema step after createReadSchema; never called by readers. */
export function createLoginSchema(database) {
  transaction(database, () => database.exec(`
    CREATE TABLE v2_credentials (
      account_id TEXT PRIMARY KEY REFERENCES v2_accounts(id), salt TEXT NOT NULL,
      hash TEXT NOT NULL, iterations INTEGER NOT NULL CHECK(iterations>0), revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE v2_login_attempts (
      username TEXT PRIMARY KEY, failures INTEGER NOT NULL, until_ms INTEGER NOT NULL
    );
    ALTER TABLE v2_sessions ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE v2_sessions ADD COLUMN touched_at_ms INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX v2_sessions_account ON v2_sessions(account_id);
    CREATE INDEX v2_sessions_expiry ON v2_sessions(expires_at_ms);
  `));
}
