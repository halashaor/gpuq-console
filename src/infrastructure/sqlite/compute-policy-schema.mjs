import {transaction} from './transaction.mjs';

/** Explicit schema step; existing unknown capacities/limits are not invented. */
export function createComputePolicySchema(database) {
  transaction(database, () => database.exec(`
    ALTER TABLE v2_machines ADD COLUMN cards INTEGER CHECK(cards>0);
    ALTER TABLE v2_machine_grants ADD COLUMN max_cards INTEGER CHECK(max_cards>0);
    CREATE TABLE v2_compute_policies (
      account_id TEXT PRIMARY KEY REFERENCES v2_accounts(id),
      total_cards INTEGER NOT NULL CHECK(total_cards>=0),
      revision INTEGER NOT NULL CHECK(revision>=0)
    );
  `));
}
