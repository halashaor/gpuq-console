import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

test('preview opt-in requires admission, off works offline, and unrelated session state is retained',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'preview-cli-')),sessionFile=join(folder,'session.json'),calls=[];
  let allow=false;
  const server=http.createServer(async(req,res)=>{let data='';for await(const b of req)data+=b;calls.push({path:req.url,body:JSON.parse(data)});
    res.setHeader('content-type','application/json');res.statusCode=allow?200:403;res.end(JSON.stringify(allow?{state:{machines:[]},principal:{userId:'fixture'}}:{error:'not invited'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  const original={url,token:'fixture',principal:{userId:'fixture'},terminalSessions:{owned:'unchanged'},projectsByMachine:{node:'project'}};
  await writeFile(sessionFile,JSON.stringify(original),{mode:0o600});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(folder,{recursive:true,force:true});});
  const cliFile=process.env.PREVIEW_TEST_CLI||fileURLToPath(new URL('../cli.mjs',import.meta.url));
  const cli=args=>new Promise((yes,no)=>{const child=spawn(process.execPath,[cliFile,...args,'--url',url,'--session-file',sessionFile,'--json']);let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',no);child.on('close',code=>yes({code,out,err}));});
  assert.equal((await cli(['preview','on'])).code,1);assert.deepEqual(JSON.parse(await readFile(sessionFile)),original);
  allow=true;const on=await cli(['preview','on']);assert.equal(on.code,0,on.err);
  assert.equal(JSON.parse(on.out).data.channel,'preview');assert.deepEqual(JSON.parse(await readFile(sessionFile)),{...original,preview:true});
  assert.ok(calls.every(c=>c.path==='/__preview__/api/call'&&c.body.operation==='state'));
  const count=calls.length;allow=false;
  assert.equal((await cli(['preview','off'])).code,0);assert.equal(calls.length,count);assert.deepEqual(JSON.parse(await readFile(sessionFile)),{...original,preview:false});
  assert.equal(JSON.parse((await cli(['preview','status'])).out).data.channel,'stable');
});
