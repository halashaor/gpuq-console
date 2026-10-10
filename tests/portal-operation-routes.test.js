import test from 'node:test';
import assert from 'node:assert/strict';
import {OPERATION_ROUTES,operationRoute,RECEIPT_ONLY_OPERATIONS} from '../portal/operation-routes.mjs';

test('each explicit operation has exactly one lane',()=>{
  const seen=new Set();
  for(const [route,operations] of Object.entries(OPERATION_ROUTES))for(const operation of operations){
    assert.equal(seen.has(operation),false,operation);seen.add(operation);
    assert.equal(operationRoute(operation),route);
  }
});
test('mutations keep serialization while long observations keep their existing lanes',()=>{
  for(const op of ['jobs.submit','jobs.cancel','jobs.priority','users.role','users.enabled','policy.save','cloud.auth.begin','maintenance.set'])
    assert.equal(operationRoute(op),'serialized',op);
  assert.equal(operationRoute('datasets.upload.admission.status'),'admissionStatus');
  assert.equal(operationRoute('datasets.upload.status'),'uploadRead');
  assert.equal(operationRoute('files.upload.status'),'remoteRead');
  assert.equal(operationRoute('terminal.exchange'),'terminalExchange');
  for(const op of ['datasets.prepare','datasets.cache.prepare','datasets.cache.cancel'])assert.equal(operationRoute(op),'datasetRead',op);
  assert.equal(operationRoute('transfers.status'),'transfer');
  assert.equal(operationRoute('cloud.import.status'),'cloud');
});
test('unknown operations retain the original queued validation, never guess a read lane',()=>{
  for(const op of ['datasets.future','jobs.future','cloud.auth.future','state.extra','__proto__','constructor',undefined,null,{},42])
    assert.equal(operationRoute(op),'serialized');
  assert.equal(RECEIPT_ONLY_OPERATIONS.has('jobs.submit'),false);
  assert.equal(RECEIPT_ONLY_OPERATIONS.has('projects.status'),true);
  assert.equal(RECEIPT_ONLY_OPERATIONS.has('datasets.upload.begin'),false);
});
