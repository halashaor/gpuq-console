import test from 'node:test';
import assert from 'node:assert/strict';
import {DatasetRequests} from '../portal/dataset-requests.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
  let actor={userId:'member',username:'member',role:'member'};
  const user={id:'member',enabled:true,limits:{node:1}},calls=[];
  let reads=0;
  const portal={datasetReadPending:0,closing:false,store:{get:()=>user},principal:()=>{reads++;return {...actor};},
    assertMaintenanceAllowed:()=>{},datasetCacheActionsCall:async(principal,operation,args)=>{calls.push({principal,operation,args});return {state:'READY'};}};
  return {portal,user,calls,requests:new DatasetRequests(portal),changeActor:value=>actor={...actor,...value},reads:()=>reads};
}
test('data orchestration snapshots arguments and validates identity once on each side of I/O',async()=>{
  const f=fixture(),done=deferred(),args={machine:'node',key:'original'};
  f.portal.datasetCacheActionsCall=async(principal,operation,request)=>{f.calls.push(request);return done.promise;};
  const work=f.requests.read('token','datasets.cache.status',args);args.key='changed';
  assert.equal(f.portal.datasetReadPending,1);assert.equal(f.calls[0].key,'original');
  done.resolve({state:'READY'});
  assert.deepEqual(await work,{result:{state:'READY'},principal:{userId:'member',username:'member',role:'member'}});
  assert.equal(f.portal.datasetReadPending,0);assert.equal(f.reads(),3,'capture, admission check, completion check; no duplicate synchronous completion check');
});
test('catalog capacity is bounded across requests and released on success or failure',async()=>{
  const f=fixture(),pending=Array.from({length:4},deferred);let count=0;
  f.portal.datasetCacheActionsCall=()=>pending[count++].promise;
  const work=pending.map(()=>f.requests.read('token','datasets.cache.status',{}));
  await assert.rejects(f.requests.read('token','datasets.cache.status',{}),e=>e.status===429);
  assert.equal(count,4);assert.equal(f.portal.datasetReadPending,4);
  const failure=assert.rejects(work[0],/node unavailable/);pending[0].reject(Error('node unavailable'));
  pending.slice(1).forEach(d=>d.resolve({state:'READY'}));await failure;await Promise.all(work.slice(1));
  assert.equal(f.portal.datasetReadPending,0);
  await assert.rejects(f.requests.catalogSlot(()=>{throw Error('sync failure');}),/sync failure/);
  assert.equal(f.portal.datasetReadPending,0);
});
test('revocation and shutdown still suppress delayed success and private node errors',async()=>{
  for(const mutate of [f=>f.changeActor({userId:'other'}),f=>f.changeActor({role:'admin'}),f=>f.user.limits.node=0,f=>f.portal.closing=true]){
    for(const failed of [false,true]){
      const f=fixture(),done=deferred();f.portal.datasetCacheActionsCall=()=>done.promise;
      const work=f.requests.read('token','datasets.cache.status',{});mutate(f);
      const check=assert.rejects(work,e=>[403,503].includes(e.status)&&!e.message.includes('private-node-detail'));
      if(failed)done.reject(Error('private-node-detail'));else done.resolve({private:'do not disclose'});
      await check;assert.equal(f.portal.datasetReadPending,0);
    }
  }
});
test('maintenance and invalid arguments stop before data execution and release capacity',async()=>{
  const f=fixture();f.portal.assertMaintenanceAllowed=()=>{throw Object.assign(Error('maintenance'),{status:503});};
  await assert.rejects(f.requests.read('token','datasets.cache.status',{}),/maintenance/);
  for(const args of [null,[],1])await assert.rejects(f.requests.read('token','datasets.cache.status',args),/参数/);
  assert.equal(f.calls.length,0);assert.equal(f.portal.datasetReadPending,0);
});
