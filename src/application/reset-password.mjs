export class ResetPassword {
  constructor({accounts, passwords, clock = Date.now}) {
    this.accounts = accounts;
    this.passwords = passwords;
    this.clock = clock;
  }

  async execute(actor, command) {
    await this.accounts.authorizePasswordReset(actor, command, this.clock());
    const password = await this.passwords.hash(command.password);
    return this.accounts.resetPassword(actor, {accountId: command.accountId, revision: command.revision, password}, this.clock());
  }
}
