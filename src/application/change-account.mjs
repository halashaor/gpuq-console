export class ChangeAccount {
  constructor({accounts, clock = Date.now}) {
    this.accounts = accounts;
    this.clock = clock;
  }

  async execute(actor, command) {
    return this.accounts.change(actor, command, this.clock());
  }
}
