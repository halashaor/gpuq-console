import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,mkdir,readFile,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assembleDataRead} from '../src/bootstrap/data-read.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport,ApiError} from '../src/client/http-transport.mjs';
import {ClientSession} from '../src/client/session.mjs';
import {DATA_READ_ROUTE} from '../src/contracts/data-read.mjs';

const request={machineId:'node-1',source:{kind:'directory',sourceId:'images'}};
async function fixture(t){
  const folder=await mkdtemp(join(tmpdir(),'v2-read-')),source=join(folder,'existing');await mkdir(source);
  await writeFile(join(source,'sample.txt'),'original sample');
  const rows=new Map([[JSON.stringify(request),{hostPath:source}]]),errors=[],actors=[];let granted=true,lookups=0;
  const handler=assembleDataRead({
    authenticate:async req=>{if(req.headers.authorization==='Bearer fixture'||req.headers.cookie==='session=fixture')return {id:'member'};throw new ApplicationError('UNAUTHENTICATED');},
    access:{requireRead:async(actor,r)=>{actors.push(actor.id);if(!granted||actor.id!=='member'||r.machineId!=='node-1')throw new ApplicationError('FORBIDDEN');}},
    catalog:{find:async r=>{lookups++;return rows.get(JSON.stringify(r));}},reportError:e=>errors.push(e),
  });
  const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const client=headers=>new DataClient({transport:new JsonHttpTransport({baseUrl,session:new ClientSession({headers})})});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(folder,{recursive:true,force:true});});
  return {folder,source,rows,errors,actors,baseUrl,client,deny:()=>granted=false,lookups:()=>lookups};
}
test('cookie and bearer callers use the same SDK, endpoint, identity and result',async t=>{
  const f=await fixture(t);
  const bearer=await f.client({Authorization:'Bearer fixture'}).resolveReadLocation(request);
  const cookie=await f.client({Cookie:'session=fixture'}).resolveReadLocation(request);
  assert.deepEqual(bearer,cookie);assert.equal(bearer.location.containerPath,'/datasets/images');
  assert.deepEqual(f.actors,['member','member','member','member']);assert.equal(f.lookups(),2);
  assert.equal(JSON.stringify(bearer).includes(f.source),false);
});
test('100 real directory resolutions retain original inode and bytes without creating a copy',async t=>{
  const f=await fixture(t),client=f.client({Authorization:'Bearer fixture'}),file=join(f.source,'sample.txt');
  const before=await stat(file),entries=await readdir(f.folder);
  const results=await Promise.all(Array.from({length:100},()=>client.resolveReadLocation(request)));
  assert.ok(results.every(r=>r.availability==='available'&&r.location.readOnly));
  const after=await stat(file);assert.equal(after.ino,before.ino);assert.equal(after.size,before.size);
  assert.equal(await readFile(file,'utf8'),'original sample');assert.deepEqual(await readdir(f.folder),entries);
  assert.deepEqual(await readdir(f.source),['sample.txt']);
});
test('missing cache does not block an existing directory or warehouse and does not trigger preparation',async t=>{
  const f=await fixture(t),client=f.client({Authorization:'Bearer fixture'});
  const warehouse={machineId:'node-1',source:{kind:'warehouse',datasetId:'images',version:'a'.repeat(64)}};
  const cache={...warehouse,source:{...warehouse.source,kind:'cache'}};
  f.rows.set(JSON.stringify(warehouse),{hostPath:f.source,ready:true});
  assert.equal((await client.resolveReadLocation(cache)).availability,'missing');
  assert.equal((await client.resolveReadLocation(request)).availability,'available');
  assert.equal((await client.resolveReadLocation(warehouse)).availability,'available');
  f.rows.set(JSON.stringify(warehouse),{hostPath:f.source,ready:false});
  assert.deepEqual(await client.resolveReadLocation(warehouse),{...warehouse,availability:'unavailable',reason:'not-ready'});
  assert.equal(f.lookups(),4);assert.deepEqual(await readdir(f.folder),['existing']);
});
test('physical missing and non-directory sources remain distinct from a readable location',async t=>{
  const f=await fixture(t),client=f.client({Authorization:'Bearer fixture'});
  f.rows.set(JSON.stringify(request),{hostPath:join(f.folder,'missing')});
  assert.equal((await client.resolveReadLocation(request)).availability,'missing');
  f.rows.set(JSON.stringify(request),{hostPath:join(f.source,'sample.txt')});
  assert.deepEqual(await client.resolveReadLocation(request),{...request,availability:'unavailable',reason:'not-directory'});
});
test('unauthenticated and denied callers cannot read the source catalogue',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.client({}).resolveReadLocation(request),e=>e instanceof ApiError&&e.code==='UNAUTHENTICATED'&&e.status===401);
  f.deny();await assert.rejects(f.client({Authorization:'Bearer fixture'}).resolveReadLocation(request),e=>e.code==='FORBIDDEN');
  assert.equal(f.lookups(),0);
});
test('HTTP validation rejects caller identity and host paths before source I/O',async t=>{
  const f=await fixture(t);
  for(const payload of [{...request,userId:'another'},{...request,hostPath:'/private'}, {...request,source:{kind:'directory',sourceId:'../private'}}]){
    const response=await fetch(f.baseUrl+DATA_READ_ROUTE,{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify(payload)});
    assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_REQUEST');
  }
  assert.equal(f.lookups(),0);
});
test('transport has no fallback or automatic retry and preserves server error codes',async()=>{
  let calls=0;
  const transport=new JsonHttpTransport({baseUrl:'https://portal.example',fetch:async()=>{calls++;return Response.json({error:{code:'SOURCE_UNAVAILABLE'}},{status:503});}});
  await assert.rejects(new DataClient({transport}).resolveReadLocation(request),e=>e.code==='SOURCE_UNAVAILABLE'&&e.status===503);assert.equal(calls,1);
  await assert.rejects(transport.request('https://other.example/api',{}),e=>e.code==='INVALID_API_ORIGIN');assert.equal(calls,1);
});

test('SDK rejects a different source, writable location or malformed successful reply',async()=>{
  const good={...request,availability:'available',location:{containerPath:'/datasets/images',readOnly:true}};
  for(const result of [null,{}, {...good,machineId:'other'}, {...good,source:{kind:'directory',sourceId:'other'}},
    {...good,hostPath:'/private'}, {...good,location:{containerPath:'/datasets/images',readOnly:false}},
    {...request,availability:'READY'}, {...request,availability:'missing',reason:'invented'}]){
    const client=new DataClient({transport:{request:async()=>({result})}});
    await assert.rejects(client.resolveReadLocation(request),e=>e.code==='INVALID_API_RESPONSE');
  }
  await assert.rejects(new DataClient({transport:{request:async()=>null}}).resolveReadLocation(request),e=>e.code==='INVALID_API_RESPONSE');
});

test('oversized and malformed JSON fail at the HTTP boundary without source work',async t=>{
  const f=await fixture(t);
  for(const body of ['{broken',JSON.stringify({...request,padding:'x'.repeat(9000)})]){
    const response=await fetch(f.baseUrl+DATA_READ_ROUTE,{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body});
    assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_REQUEST');
  }
  assert.equal(f.lookups(),0);
});

test('filesystem diagnostics stay in server reporting, not in the public error',async t=>{
  const f=await fixture(t);f.rows.set(JSON.stringify(request),{hostPath:f.source+'\0private-detail'});
  await assert.rejects(f.client({Authorization:'Bearer fixture'}).resolveReadLocation(request),e=>e.code==='SOURCE_UNAVAILABLE'&&e.status===503&&!e.message.includes('private'));
  assert.equal(f.errors.length,1);assert.ok(f.errors[0].cause);
});
