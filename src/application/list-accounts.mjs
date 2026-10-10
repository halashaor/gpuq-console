export class ListAccounts {
  constructor({accounts, clock = Date.now}) {
    this.accounts = accounts;
    this.clock = clock;
  }

  async execute(actor, query) {
    return this.accounts.list(actor, query, this.clock());
  }
}
