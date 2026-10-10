export class CreateAccount {
  constructor({accounts, passwords, clock = Date.now}) {
    this.accounts = accounts;
    this.passwords = passwords;
    this.clock = clock;
  }

  async execute(actor, command) {
    await this.accounts.authorizeCreate(actor, this.clock());
    const password = await this.passwords.hash(command.password);
    return this.accounts.create(actor, {...command, password}, this.clock());
  }
}
