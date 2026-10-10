export class GetComputePolicy {
  constructor({policies, clock = Date.now}) {this.policies = policies; this.clock = clock;}
  async execute(actor, {accountId}) {return this.policies.get(actor, accountId, this.clock());}
}

export class SetComputePolicy {
  constructor({policies, clock = Date.now}) {this.policies = policies; this.clock = clock;}
  async execute(actor, command) {return this.policies.set(actor, command, this.clock());}
}
