// Explicit initial schema. Repositories never create or migrate tables.
// Currently used only in independent V2 databases, not the production store.
export function createReadSchema(database){
  database.exec('BEGIN');
  try{database.exec(`
    CREATE TABLE v2_accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), auth_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE v2_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES v2_accounts(id),
      auth_revision INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    );
    CREATE TABLE v2_machines (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)));
    CREATE TABLE v2_machine_grants (
      account_id TEXT NOT NULL REFERENCES v2_accounts(id), machine_id TEXT NOT NULL REFERENCES v2_machines(id),
      PRIMARY KEY(account_id,machine_id)
    );
    CREATE TABLE v2_data_resources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('directory','dataset')),
      machine_id TEXT, source_id TEXT NOT NULL, version TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('shared','private')), owner_id TEXT REFERENCES v2_accounts(id),
      CHECK((kind='directory' AND machine_id IS NOT NULL AND version IS NULL)
        OR (kind='dataset' AND machine_id IS NULL AND version IS NOT NULL))
    );
    CREATE UNIQUE INDEX v2_directory_identity ON v2_data_resources(machine_id,source_id) WHERE kind='directory';
    CREATE UNIQUE INDEX v2_dataset_identity ON v2_data_resources(source_id,version) WHERE kind='dataset';
    CREATE TABLE v2_data_readers (
      resource_id TEXT NOT NULL REFERENCES v2_data_resources(id), account_id TEXT NOT NULL REFERENCES v2_accounts(id),
      PRIMARY KEY(resource_id,account_id)
    );
    CREATE TABLE v2_source_bindings (
      resource_id TEXT NOT NULL REFERENCES v2_data_resources(id), machine_id TEXT NOT NULL,
      storage_kind TEXT NOT NULL CHECK(storage_kind IN ('directory','warehouse','cache')),
      host_path TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)),
      PRIMARY KEY(resource_id,machine_id,storage_kind)
    );
    COMMIT;`);}catch(error){database.exec('ROLLBACK');throw error;}
}
