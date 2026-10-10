import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientSession} from '../src/client/session.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
test('credential replacement cancels old requests and new calls use only new credentials',async()=>{
  const session=new ClientSession({headers:{Authorization:'Bearer first'}}),pending=deferred(),sent=[];
  const transport=new JsonHttpTransport({baseUrl:'https://portal.example',session,fetch:async(url,options)=>{
    sent.push(options);return sent.length===1?pending.promise:Response.json({result:'new'});
  }});
  const old=transport.request('/api/v2/data/read-location',{});
  session.replace({headers:{Authorization:'Bearer second'}});
  const rejected=assert.rejects(old,e=>e.code==='SESSION_CHANGED');pending.resolve(Response.json({result:'private-old-user'}));await rejected;
  assert.equal(sent[0].signal.aborted,true);assert.equal(sent[0].headers.Authorization,'Bearer first');
  assert.deepEqual(await transport.request('/api/v2/data/read-location',{}),{result:'new'});
  assert.equal(sent[1].headers.Authorization,'Bearer second');assert.equal(sent.length,2,'no automatic replay');
});
test('session switch during response decoding cannot release an old account result or error',async()=>{
  for(const failed of [false,true]){
    const session=new ClientSession(),decoding=deferred(),started=deferred();
    const transport=new JsonHttpTransport({baseUrl:'https://portal.example',session,fetch:async()=>({ok:true,status:200,json:()=>{started.resolve();return decoding.promise;}})});
    const work=transport.request('/api/v2/data/read-location',{});await started.promise;session.replace();
    const rejected=assert.rejects(work,e=>e.code==='SESSION_CHANGED');
    if(failed)decoding.reject(Error('old private body'));else decoding.resolve({private:'old'});
    await rejected;
  }
});
test('closed sessions and pre-aborted requests make no HTTP call',async()=>{
  let calls=0;const session=new ClientSession();
  const transport=new JsonHttpTransport({baseUrl:'https://portal.example',session,fetch:async()=>{calls++;}});
  session.close();await assert.rejects(transport.request('/api/v2/data/read-location',{}),e=>e.code==='SESSION_CLOSED');
  session.replace();const abort=new AbortController();abort.abort();
  await assert.rejects(transport.request('/api/v2/data/read-location',{}, {signal:abort.signal}),e=>e.code==='REQUEST_ABORTED');
  assert.equal(calls,0);
});
test('caller cancellation does not invalidate the login or replay a request',async()=>{
  let calls=0;const session=new ClientSession(),abort=new AbortController();
  const transport=new JsonHttpTransport({baseUrl:'https://portal.example',session,fetch:async()=>{calls++;abort.abort();return Response.json({result:'discarded'});}});
  await assert.rejects(transport.request('/api/v2/data/read-location',{}, {signal:abort.signal}),e=>e.code==='REQUEST_ABORTED');
  assert.equal(session.snapshot().signal.aborted,false);assert.equal(calls,1);
});
