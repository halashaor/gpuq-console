import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createPortalServer} from '../portal-server.mjs';
import {createPreviewServer} from '../preview-server.mjs';

const folder=await mkdtemp(join(tmpdir(),'preview-ui-'));
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const origin=`http://127.0.0.1:${port}`,bootstrap=join(folder,'bootstrap.json');
await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Preview-Fixture-Password-Only-2026!'}),{mode:0o600});
const {server:stable,service}=await createPortalServer({database:join(folder,'database'),bootstrap,origin,secure:false,
  bridge:async()=>{throw Error('No real executor in preview test');}});
await new Promise(r=>stable.listen(0,'127.0.0.1',r));
const login=await service.login('admin','Preview-Fixture-Password-Only-2026!');
const preview=createPreviewServer({upstream:`http://127.0.0.1:${stable.address().port}`,publicOrigin:origin,users:[login.principal.userId]});
await new Promise(r=>preview.listen(port,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try{
  await mkdir('/tmp/stargate-preview-ui',{recursive:true});
  for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:900}});
    await context.addCookies([{name:'gpuq_session',value:login.token,url:origin,httpOnly:true,sameSite:'Strict'}]);
    const page=await context.newPage(),errors=[],calls=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/'))calls.push(new URL(request.url()).pathname);});
    const response=await page.goto(origin+'/__preview__/');assert.equal(response.status(),200);
    await page.locator('.preview-banner').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('[data-room]'));
    await page.waitForTimeout(500);
    assert.ok(calls.length>0);assert.ok(calls.every(path=>path.startsWith('/__preview__/api/')),JSON.stringify(calls));
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
    await page.screenshot({path:`/tmp/stargate-preview-ui/preview-${width}.png`,fullPage:true});
    await context.close();
  }
  console.log('PASS preview real Portal integration: cookie session, prefixed assets/API, visible banner, 1440/390/320, no JS errors');
}finally{
  await browser.close();for(const s of [preview,stable]){s.closeAllConnections();await new Promise(r=>s.close(r));}
  await rm(folder,{recursive:true,force:true});
}
