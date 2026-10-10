import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsControlFetch} from '../client-windows-control.mjs';
test('Windows control passes the same-origin preview call once without opening other endpoints',async()=>{
  const frames=[];
  const control=createWindowsControlFetch('https://portal.example',{agentFactory:()=>({request:async(frame,raw)=>{frames.push({frame,raw});return {value:{status:200},raw:Buffer.from('{"state":{}}')};},destroy:async()=>{}})});
  const options={method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer fixture'},body:'{"operation":"state","args":{}}'};
  try{
    assert.equal((await control.fetchImpl('https://portal.example/__preview__/api/call',options)).status,200);
    assert.equal(frames.length,1);assert.equal(frames[0].frame.control.path,'/__preview__/api/call');
    for(const path of ['https://other.example/__preview__/api/call','https://portal.example/__preview__/api/login','https://portal.example/__preview__/api/call?x=1'])await assert.rejects(control.fetchImpl(path,options));
    assert.equal(frames.length,1);
  }finally{await control.close();}
});
