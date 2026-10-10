/** Prepare/import V2 ACL state; node authority switching is a separate action. */
export class ImportDataAccess {
  #mapping;
  constructor({imports, legacyAccess, accountMapping, clock = Date.now}) {
    this.imports = imports;
    this.legacyAccess = legacyAccess;
    this.#mapping = accountMapping.map(({legacyId, accountId}) => ({legacyId, accountId}));
    this.clock = clock;
  }

  async #observe(actor, resourceId) {
    const resource = await this.imports.describe(actor, resourceId, this.clock());
    const observations = [];
    for (const {machineId, kind} of resource.bindings) {
      try {
        observations.push(await this.legacyAccess.exportAccess({machineId,
          source: {kind, datasetId: resource.datasetId, version: resource.version}}));
      } finally {
        await this.imports.authorize(actor, this.clock());
      }
    }
    return observations;
  }

  async plan(actor, {resourceId}) {
    const observations = await this.#observe(actor, resourceId);
    return this.imports.plan(actor, resourceId, observations, this.#mapping, this.clock());
  }

  async apply(actor, command) {
    const receipt = await this.imports.receiptForCommand(actor, command, this.clock());
    if (receipt) return receipt;
    const observations = await this.#observe(actor, command.resourceId);
    return this.imports.apply(actor, command, observations, this.#mapping, this.clock());
  }

  async receipt(actor, command) {
    return this.imports.receipt(actor, command, this.clock());
  }
}
