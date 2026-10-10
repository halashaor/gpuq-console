import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {assembleDataRead} from '../src/bootstrap/data-read.mjs';
import {LocalSourceReader} from '../src/infrastructure/local-source-reader.mjs';
import {ApplicationError} from '../src/domain/errors.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {ClientSession} from '../src/client/session.mjs';

const directory=await mkdtemp(join(tmpdir(),'v2-browser-read-')),source=join(directory,'source');
await mkdir(source);await writeFile(join(source,'sample'),'original');
let allowed=true,lookups=0;const channels=[],errors=[];
const handler=assembleDataRead({
  authenticate:async req=>{
    if(req.headers.authorization==='Bearer fixture'){channels.push('bearer');return {id:'member'};}
    if(req.headers.cookie==='session=fixture'){channels.push('cookie');return {id:'member'};}
    throw new ApplicationError('UNAUTHENTICATED');
  },
  access:{requireRead:async()=>{if(!allowed)throw new ApplicationError('FORBIDDEN');}},
  sources:new LocalSourceReader({machineId:'node-1',catalog:{find:async()=>{lookups++;return {hostPath:source};}}}),reportError:error=>errors.push(error),
});
const modules=new Map(['client/data-client.mjs','client/http-transport.mjs','client/session.mjs','client/errors.mjs','contracts/data-read.mjs','contracts/errors.mjs'].map(name=>['/modules/'+name,new URL('../src/'+name,import.meta.url)]));
const server=http.createServer(async(req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>V2 SDK fixture</title>');return;}
  if(modules.has(req.url)){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(modules.get(req.url)));return;}
  await handler(req,res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const baseUrl=`http://127.0.0.1:${server.address().port}`,request={machineId:'node-1',source:{kind:'directory',sourceId:'images'}};
const browser=await chromium.launch({headless:true});
try{
  const client=new DataClient({transport:new JsonHttpTransport({baseUrl,session:new ClientSession({headers:{Authorization:'Bearer fixture'}})})});
  const nodeResult=await client.resolveReadLocation(request);
  const context=await browser.newContext();await context.addCookies([{name:'session',value:'fixture',url:baseUrl,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error));await page.goto(baseUrl);
  const browserResult=await page.evaluate(async request=>{
    const {DataClient}=await import('/modules/client/data-client.mjs');
    const {JsonHttpTransport}=await import('/modules/client/http-transport.mjs');
    globalThis.dataClient=new DataClient({transport:new JsonHttpTransport({baseUrl:location.origin})});
    return globalThis.dataClient.resolveReadLocation(request);
  },request);
  assert.deepEqual(browserResult,nodeResult);assert.deepEqual(channels,['bearer','cookie']);assert.equal(lookups,2);
  allowed=false;
  const denied=await page.evaluate(async request=>{try{await globalThis.dataClient.resolveReadLocation(request);}catch(error){return {code:error.code,status:error.status};}},request);
  assert.deepEqual(denied,{code:'FORBIDDEN',status:403});assert.equal(lookups,2);assert.deepEqual(errors,[]);
  const callsBeforeClose=channels.length;
  const closed=await page.evaluate(async request=>{
    globalThis.dataClient.transport.session.close();
    try{await globalThis.dataClient.resolveReadLocation(request);}catch(error){return error.code;}
  },request);
  assert.equal(closed,'SESSION_CLOSED');assert.equal(channels.length,callsBeforeClose);
  allowed=true;
  const reopened=await page.evaluate(async request=>{globalThis.dataClient.transport.session.replace();return globalThis.dataClient.resolveReadLocation(request);},request);
  assert.deepEqual(reopened,nodeResult);assert.equal(lookups,3);
  assert.equal(await readFile(join(source,'sample'),'utf8'),'original');
  console.log('PASS V2 real browser and Node use identical SDK/API; cookie/bearer authorization, client session close/reopen and unchanged source verified');
}finally{
  await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});
}
