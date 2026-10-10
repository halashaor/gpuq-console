// Scheduling lanes are an API concern, not a list repeated by each feature.
// Unknown operations retain the serialized path and its existing validation.
export const OPERATION_ROUTES={
  state:['state'],
  uploadRead:['datasets.upload.routes','datasets.upload.status'],
  admissionStatus:['datasets.upload.admission.status'],
  taskDisplay:['tasks.display.get','tasks.display.set'],
  fileTicket:['files.direct-ticket'],
  remoteRead:['host.status','files.upload.status','files.get','files.list'],
  projectReplication:['projects.replicate','projects.replication.status','projects.replication.cancel','projects.replication.retry'],
  datasetLabel:['datasets.label.get','datasets.label.set'],
  terminalExchange:['terminal.exchange'],
  datasetDeletion:['datasets.delete','datasets.delete.status','datasets.delete.restore','datasets.delete.continue','datasets.delete.cancel'],
  storageUsage:['storage.usage.mine','storage.usage.users'],
  datasetRead:[
    'datasets.catalog','datasets.capacity','datasets.overview','datasets.files.list','datasets.training.capabilities',
    'datasets.list','datasets.status','datasets.prepare','datasets.cache.capabilities','datasets.cache.prepare',
    'datasets.cache.release','datasets.cache.status','datasets.cache.cancel',
  ],
};
const exactRoutes=new Map(Object.entries(OPERATION_ROUTES).flatMap(([route,operations])=>operations.map(operation=>[operation,route])));
export function operationRoute(operation){
  const exact=exactRoutes.get(operation);
  if(exact)return exact;
  if(typeof operation==='string'){
    if(operation.startsWith('transfers.'))return 'transfer';
    if(operation.startsWith('cloud.')&&!operation.startsWith('cloud.auth.'))return 'cloud';
  }
  return 'serialized';
}

// Receipt-only responses still authorize and execute normally. They merely
// omit the unrelated full dashboard from status queries and terminal polling.
export const RECEIPT_ONLY_OPERATIONS=new Set([
  'datasets.upload.routes','datasets.upload.status','datasets.upload.direct-ticket',
  'datasets.storage.status','datasets.storage.plan','datasets.workspace.list','datasets.workspace.get','datasets.workspace.status',
  'datasets.snapshot.info','datasets.snapshot.manifest','datasets.snapshot.get',
  'projects.list','projects.quota','projects.status','projects.local-import.status','projects.retire.plan','projects.retire.status',
  'projects.label.get','projects.group.get','projects.catalog',
  'projects.snapshot.info','projects.snapshot.manifest','projects.snapshot.get','projects.sync.status',
  'jobs.logs','jobs.watch','jobs.diagnostics','jobs.completion','files.upload.list','terminal.status',
]);
