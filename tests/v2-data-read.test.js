import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDataReadRequest,InvalidRequest} from '../src/contracts/data-read.mjs';
import {ResolveDataRead} from '../src/application/resolve-data-read.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';

const version='a'.repeat(64);
const directory={machineId:'node-1',source:{kind:'directory',sourceId:'imagenet'}};
test('one request contract distinguishes direct directory, warehouse and cache without implicit modes',()=>{
  const parsed=parseDataReadRequest(directory);assert.deepEqual(parsed,directory);assert.notEqual(parsed.source,directory.source);
  for(const kind of ['warehouse','cache']){
    const request={machineId:'node-1',source:{kind,datasetId:'images',version}};
    assert.deepEqual(parseDataReadRequest(request),request);
  }
  for(const request of [null,[],{...directory,hostPath:'/private'}, {...directory,userId:'another'},
    {machineId:'../node',source:directory.source},{machineId:'node-1',source:{kind:'auto',sourceId:'images'}},
    {machineId:'node-1',source:{kind:'directory',sourceId:'../images'}},
    {machineId:'node-1',source:{kind:'warehouse',datasetId:'images',version:'short'}}])assert.throws(()=>parseDataReadRequest(request),InvalidRequest);
});
test('the use case receives only access and source-reader ports, with no copy, quota or Portal service',async()=>{
  const calls=[],access={requireRead:async(actor,request)=>calls.push(['access',actor.id,request])};
  const sources={inspect:async request=>{calls.push(['inspect',request]);return {availability:'available'};}};
  const useCase=new ResolveDataRead({access,sources});
  const result=await useCase.execute({id:'member'},parseDataReadRequest(directory));
  assert.deepEqual(result,{...directory,availability:'available',location:{containerPath:'/datasets/imagenet',readOnly:true}});
  assert.deepEqual(calls.map(c=>c[0]),['access','inspect','access']);
  assert.deepEqual(Object.keys(useCase).sort(),['access','sources']);
});
test('warehouse and cache remain explicit independent sources with the same logical container alias',async()=>{
  const seen=[],useCase=new ResolveDataRead({access:{requireRead:async()=>{}},sources:{inspect:async r=>{seen.push(r.source.kind);return {availability:'available'};}}});
  for(const kind of ['warehouse','cache']){
    const result=await useCase.execute({id:'member'},{machineId:'node-1',source:{kind,datasetId:'images',version}});
    assert.deepEqual(result.location,{containerPath:'/data2/images',readOnly:true});assert.equal(result.source.kind,kind);
  }
  assert.deepEqual(seen,['warehouse','cache']);
});
test('missing and unavailable observations never fall back to another source or become ready',async()=>{
  for(const observation of [{availability:'missing',reason:'not-found'},{availability:'unavailable',reason:'not-readable'}]){
    let reads=0;
    const useCase=new ResolveDataRead({access:{requireRead:async()=>{}},sources:{inspect:async()=>{reads++;return {...observation,hostPath:'/private/source'};}}});
    assert.deepEqual(await useCase.execute({id:'member'},directory),{...directory,...observation});assert.equal(reads,1);
  }
});
test('denied access performs no I/O and revocation during I/O hides the delayed result or error',async()=>{
  let reads=0;
  const denied=new ResolveDataRead({access:{requireRead:async()=>{throw new ApplicationError('FORBIDDEN');}},sources:{inspect:async()=>{reads++;}}});
  await assert.rejects(denied.execute({id:'member'},directory),e=>e.code==='FORBIDDEN');assert.equal(reads,0);
  for(const failed of [false,true]){
    let allowed=true;
    const useCase=new ResolveDataRead({access:{requireRead:async()=>{if(!allowed)throw new ApplicationError('FORBIDDEN');}},
      sources:{inspect:async()=>{allowed=false;if(failed)throw Error('private filesystem detail');return {availability:'available'};}}});
    await assert.rejects(useCase.execute({id:'member'},directory),e=>e.code==='FORBIDDEN'&&!e.message.includes('private'));
  }
});
