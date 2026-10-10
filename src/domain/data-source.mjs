/** Container naming is a single shared rule; host paths belong to adapters. */
export function containerPathFor(source){
  switch(source.kind){
    case 'directory':return `/datasets/${source.sourceId}`;
    case 'warehouse':
    case 'cache':return `/data2/${source.datasetId}`;
    default:throw Error('Unsupported internal data source');
  }
}
