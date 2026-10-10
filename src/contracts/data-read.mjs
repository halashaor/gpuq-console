export const DATA_READ_ROUTE='/api/v2/data/read-location';

import {InvalidRequest, InvalidResponse} from './errors.mjs';
export {InvalidRequest, InvalidResponse} from './errors.mjs';

const identifier=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const version=/^[a-f0-9]{64}$/;
function fields(value,names,path){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))throw new InvalidRequest(path);
}
function id(value,path){
  if(typeof value!=='string'||!identifier.test(value))throw new InvalidRequest(path);
  return value;
}

/** Parse once at the API boundary. No host paths or caller-supplied identity. */
export function parseDataReadRequest(value){
  fields(value,['machineId','source'],'request');
  const machineId=id(value.machineId,'machineId'),source=value.source;
  if(source?.kind==='directory'){
    fields(source,['kind','sourceId'],'source');
    return {machineId,source:{kind:'directory',sourceId:id(source.sourceId,'source.sourceId')}};
  }
  if(source?.kind==='warehouse'||source?.kind==='cache'){
    fields(source,['kind','datasetId','version'],'source');
    if(typeof source.version!=='string'||!version.test(source.version))throw new InvalidRequest('source.version');
    return {machineId,source:{kind:source.kind,datasetId:id(source.datasetId,'source.datasetId'),version:source.version}};
  }
  throw new InvalidRequest('source.kind');
}

export function parseDataReadResult(value){
  try{
    const reference=parseDataReadRequest({machineId:value.machineId,source:value.source});
    if(value.availability==='available'){
      fields(value,['machineId','source','availability','location'],'result');
      fields(value.location,['containerPath','readOnly'],'location');
      const {containerPath,readOnly}=value.location;
      if(typeof containerPath!=='string'||!containerPath.startsWith('/')||containerPath.includes('\0')||readOnly!==true)throw new InvalidResponse();
      return {...reference,availability:'available',location:{containerPath,readOnly}};
    }
    fields(value,['machineId','source','availability','reason'],'result');
    if(!['missing','unavailable'].includes(value.availability)||!['not-found','not-readable','not-ready','not-directory'].includes(value.reason))throw new InvalidResponse();
    return {...reference,availability:value.availability,reason:value.reason};
  }catch{throw new InvalidResponse();}
}

/** @typedef {{kind:'directory',sourceId:string}|{kind:'warehouse'|'cache',datasetId:string,version:string}} DataSource */
/** @typedef {{machineId:string,source:DataSource}} DataReadRequest */
/** @typedef {{machineId:string,source:DataSource,availability:'available',location:{containerPath:string,readOnly:true}}|{machineId:string,source:DataSource,availability:'missing'|'unavailable',reason:string}} DataReadResult */
