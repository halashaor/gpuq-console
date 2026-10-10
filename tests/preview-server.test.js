import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPreviewServer} from '../preview-server.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'stargate-preview-'));await mkdir(join(root,'dist'));await mkdir(join(root,'build'));
  await writeFile(join(root,'dist/client.js'),'candidate-client');await writeFile(join(root,'dist/preview.css'),'.preview-banner{}');
  await writeFile(join(root,'build/gpuctl.mjs'),'const origin="__GPUQ_PUBLIC_ORIGIN__";');
  const calls=[];let user='tester',writeStatus=200;
  const stable=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/call'){
      let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls.push(body);
      if(body.operation==='state')return res.end(JSON.stringify({principal:{userId:user},state:{jobs:[]}}));
      res.statusCode=writeStatus;res.end(JSON.stringify({result:{id:body.args.key}}));return;
    }
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<html><head><script src="/client.js"></script></head><body>stable</body></html>');}
    if(req.url==='/client.js')return res.end('stable-client');
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>stable.listen(0,'127.0.0.1',r));
  const preview=createPreviewServer({upstream:`http://127.0.0.1:${stable.address().port}`,publicOrigin:'https://portal.example',users:['tester'],root});
  await new Promise(r=>preview.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [preview,stable]){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${preview.address().port}`;
  return {calls,base,read:(path,options={})=>fetch(base+path,{...options,headers:{authorization:'Bearer fixture',...options.headers}}),setUser:v=>user=v,setWriteStatus:v=>writeStatus=v};
}
test('preview serves candidate assets and a visible real-resource banner without opening a state store',async t=>{
  const f=await fixture(t);const html=await(await f.read('/__preview__/')).text();
  assert.match(html,/\/__preview__\/client.js/);assert.match(html,/灰度版 · 真实资源/);assert.match(html,/preview.css/);
  assert.equal(await(await f.read('/__preview__/client.js')).text(),'candidate-client');
  assert.equal((await f.read('/')).status,404);
  assert.equal((await f.read('/__preview__/api/login',{method:'POST'})).status,405);
});
test('preview checks current membership before every asset or mutation and never broadens caller authority',async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.base+'/__preview__/')).status,401);assert.equal(f.calls.length,0);
  f.setUser('other');assert.equal((await f.read('/__preview__/')).status,403);
  const body={operation:'jobs.submit',args:{key:'original',argv:['true']}};
  const request=()=>f.read('/__preview__/api/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await request()).status,403);assert.ok(f.calls.every(c=>c.operation==='state'));
  f.setUser('tester');assert.equal((await request()).status,200);assert.deepEqual(f.calls.at(-1),body);
  f.setUser('other');assert.equal((await request()).status,403);assert.equal(f.calls.filter(c=>c.operation==='jobs.submit').length,1);
});
test('ambiguous writes are forwarded once and cookie writes require the same public origin',async t=>{
  const f=await fixture(t);f.setWriteStatus(503);
  const body=JSON.stringify({operation:'jobs.submit',args:{key:'unchanged'}});
  assert.equal((await f.read('/__preview__/api/call',{method:'POST',headers:{'content-type':'application/json'},body})).status,503);
  assert.equal(f.calls.filter(c=>c.operation==='jobs.submit').length,1);
  const response=await fetch(f.base+'/__preview__/api/call',{method:'POST',headers:{cookie:'gpuq_session=fixture','content-type':'application/json',origin:'https://evil.example'},body});
  assert.equal(response.status,403);assert.equal(f.calls.filter(c=>c.operation==='jobs.submit').length,1);
});
test('public preview client contains only the canonical origin and grants no preview membership',async t=>{
  const f=await fixture(t);const text=await(await fetch(f.base+'/__preview__/gpuctl.mjs')).text();
  assert.match(text,/https:\/\/portal.example/);assert.doesNotMatch(text,/__GPUQ_PUBLIC_ORIGIN__/);assert.equal(f.calls.length,0);
});
