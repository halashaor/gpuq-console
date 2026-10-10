/** Local client state, never the server's session database. Methods are synchronous. */
export class SqliteClientCredentials {
  constructor({database}) {
    this.database = database;
  }

  load(origin) {
    return this.database.prepare('SELECT credential FROM client_credentials_v1 WHERE origin=?').get(origin)?.credential ?? null;
  }

  save(origin, credential) {
    this.database.prepare(`INSERT INTO client_credentials_v1(origin,credential) VALUES(?,?)
      ON CONFLICT(origin) DO UPDATE SET credential=excluded.credential`).run(origin, credential);
  }

  // An old process may finish logout after a newer process has logged in.
  remove(origin, credential) {
    this.database.prepare('DELETE FROM client_credentials_v1 WHERE origin=? AND credential=?').run(origin, credential);
  }
}

export function createClientCredentialSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS client_credentials_v1 (
    origin TEXT PRIMARY KEY, credential TEXT NOT NULL
  )`);
}
