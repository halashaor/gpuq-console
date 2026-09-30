// Resolve the real browser import graph; synthetic static servers cannot catch
// a missing module in the production/demo allowlists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer as reserveServer} from 'node:net';
import {build} from 'esbuild';
import {createPortalServer} from '../portal-server.mjs';
import {createServer} from '../server.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
async function graph(){
  const result=await build({absWorkingDir:root,entryPoints:['dist/app.js'],bundle:true,platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent'});
  return Object.keys(result.metafile.inputs);
}
for(const kind of ['portal','demo'])test(`${kind} serves every module in the real browser import graph`,async t=>{
  const folder=await mkdtemp(join(tmpdir(),'gpuq-web-modules-'));
  const reservation=reserveServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const origin='http://127.0.0.1:'+port;let server;
  if(kind==='portal'){
    const bootstrap=join(folder,'bootstrap');await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Static-Modules-Fixture-2026!'}));
    ({server}=await createPortalServer({database:join(folder,'db'),bootstrap,origin,secure:false}));
  }else server=await createServer();
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const modules=await graph();assert.ok(modules.includes('dist/gpu-allocation.js'));assert.ok(modules.includes('dist/gpu-allocation-ui.js'));assert.ok(modules.includes('dist/fleet-routing-ui.js'));
  for(const name of modules){
    assert.ok(name.startsWith('dist/'),name);
    const response=await fetch(origin+'/'+name.slice(5));
    // DemoClient only dynamically imports this in non-remote embedded demo
    // mode. Production deliberately does not expose the demo account module.
    if(kind==='portal'&&name==='dist/service.js'){assert.equal(response.status,404);continue;}
    assert.equal(response.status,200,`${kind}: ${name}`);assert.match(response.headers.get('content-type'),/javascript/,name);
    assert.equal(await response.text(),await readFile(join(root,name),'utf8'),name);
  }
  // Serving graph modules must not broaden the explicit public boundary.
  for(const name of ['portal-service.mjs','execution.mjs','inventory.json','package-lock.json'])assert.equal((await fetch(origin+'/'+name)).status,404,name);
});
