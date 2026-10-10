export class GetDataAccess {
  constructor({access, clock = Date.now}) {this.access = access; this.clock = clock;}
  async execute(actor, {resourceId}) {return this.access.get(actor, resourceId, this.clock());}
}

export class SetDataReaders {
  constructor({access, clock = Date.now}) {this.access = access; this.clock = clock;}
  async execute(actor, command) {return this.access.setReaders(actor, command, this.clock());}
}
