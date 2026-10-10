/** Pure migration review. A proposal is not permission to switch a node. */
export function planDataAccessImport({resource, observations, accountMapping, knownAccountIds}) {
  const blocked = (code, accounts = []) => ({state: 'blocked', resourceId: resource.resourceId, reason: code, accounts});
  if (resource.visibility !== 'private') return blocked('SHARED_SOURCE_REQUIRES_REVIEW');
  if (!observations.length) return blocked('SOURCE_SNAPSHOTS_REQUIRED');
  const expectedLocations = new Set(resource.bindings.map(binding => `${binding.machineId}/${binding.kind}`));
  if (!expectedLocations.size) return blocked('SOURCE_BINDINGS_REQUIRED');
  const mapping = new Map(), known = new Set(knownAccountIds);
  for (const {legacyId, accountId} of accountMapping) {
    if (mapping.has(legacyId)) return blocked('DUPLICATE_ACCOUNT_MAPPING', [legacyId]);
    mapping.set(legacyId, accountId);
  }
  const missing = new Set(), unknown = new Set(), replicas = [], locations = new Set();
  for (const observation of observations) {
    const source = observation.source;
    if (!['warehouse', 'cache'].includes(source.kind) || source.datasetId !== resource.datasetId || source.version !== resource.version) return blocked('SOURCE_IDENTITY_MISMATCH');
    const location = `${observation.machineId}/${source.kind}`;
    if (!expectedLocations.has(location)) return blocked('UNREGISTERED_SOURCE_SNAPSHOT');
    if (locations.has(location)) return blocked('DUPLICATE_SOURCE_SNAPSHOT');
    locations.add(location);
    const accounts = new Set();
    for (const legacyId of observation.legacyOwners) {
      const accountId = mapping.get(legacyId);
      if (accountId === undefined) missing.add(legacyId);
      else if (!known.has(accountId)) unknown.add(accountId);
      else accounts.add(accountId);
    }
    replicas.push([...accounts].sort());
  }
  if (locations.size !== expectedLocations.size) return blocked('SOURCE_SNAPSHOTS_REQUIRED');
  if (missing.size) return blocked('ACCOUNT_MAPPING_REQUIRED', [...missing].sort());
  if (unknown.size) return blocked('TARGET_ACCOUNT_NOT_FOUND', [...unknown].sort());
  if (replicas.some(accounts => JSON.stringify(accounts) !== JSON.stringify(replicas[0]))) return blocked('REPLICA_ACL_CONFLICT');
  const accounts = replicas[0];
  if (!accounts.includes(resource.ownerId)) return blocked('RESOURCE_OWNER_CONFLICT');
  const readers = accounts.filter(id => id !== resource.ownerId);
  if (readers.length > 100) return blocked('READER_LIMIT_REQUIRES_REVIEW');
  const current = [...new Set([resource.ownerId, ...resource.readers])].sort();
  if ((resource.revision > 0 || resource.readers.length) && JSON.stringify(current) !== JSON.stringify(accounts)) return blocked('EXISTING_V2_ACL_CONFLICT');
  return {state: 'proposed', resourceId: resource.resourceId, expectedRevision: resource.revision, ownerId: resource.ownerId,
    readers, accountMapping: [...new Set(observations.flatMap(row => row.legacyOwners))].sort()
      .map(legacyId => ({legacyId, accountId: mapping.get(legacyId)})),
    snapshots: observations.map(({machineId, source, snapshotId}) => ({machineId, source: {...source}, snapshotId}))};
}
