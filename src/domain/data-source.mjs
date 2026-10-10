/** Container naming is a single shared rule; host paths belong to adapters. */
export function containerPathFor(source){
  switch(source.kind){
    case 'directory':return `/datasets/${source.sourceId}`;
    case 'warehouse':
    case 'cache':return `/data2/${source.datasetId}`;
    default:throw Error('Unsupported internal data source');
  }
}

// Warehouse and cache are locations of the same dataset permission resource.
export function permissionResourceFor({machineId,source}){
  switch(source.kind){
    case 'directory':return {kind:'directory',machineId,sourceId:source.sourceId,version:null};
    case 'warehouse':
    case 'cache':return {kind:'dataset',machineId:null,sourceId:source.datasetId,version:source.version};
    default:throw Error('Unsupported internal data source');
  }
}
