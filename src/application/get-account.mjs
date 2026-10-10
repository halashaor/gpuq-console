export class GetAccount {
  constructor({accounts, clock = Date.now}) {
    this.accounts = accounts;
    this.clock = clock;
  }

  async execute(actor, {accountId}) {
    return this.accounts.get(actor, accountId, this.clock());
  }
}
