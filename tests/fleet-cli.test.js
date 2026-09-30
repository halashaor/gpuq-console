import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {standaloneClient} from '../client-bundle.mjs';
const a='a'.repeat(64),b='b'.repeat(64);
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-fleet-cli-')),session=join(dir,'session'),file=join(dir,'gpuctl.mjs'),launcher=join(dir,'gpuctl'),calls=[];await writeFile(file,await standaloneClient());await symlink(file,launcher);
  const principal={userId:'demo-user-1',username:'alice',role:'member'},state={demo:false,gpuqConnected:true,machines:[{id:'gpu-1',cards:8},{id:'gpu-2',cards:8}],users:[],jobs:[]};
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const {operation,args={}}=JSON.parse(raw);calls.push({operation,args});res.setHeader('Content-Type','application/json');if(operation==='state'){res.end(JSON.stringify({state,principal}));return;}const result=operation==='projects.status'?{project:args.project,latestReadyRelease:a,releases:[{release:a,state:'READY'}]}:{id:'fixture-job',machine:null,automatic:true,state:'WAITING_POOL',candidateHosts:args.hosts,cards:args.cards};res.end(JSON.stringify({result,state,principal}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;await writeFile(session,JSON.stringify({url,token:'fixture-only',principal,machine:'gpu-1',projectsByMachine:{'gpu-1':'vision'}}));
  const cli=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[launcher,'--url',url,'--session-file',session,'--json',...args]);let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',reject);child.on('close',code=>resolve({code,stderr,data:stdout?JSON.parse(stdout):null}));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});return {calls,cli};
}
test('installed standalone fleet CLI expands explicit all and preserves pinned per-node releases and literal training flags',async t=>{
  const f=await fixture(t),r=await f.cli(['run','auto','--hosts','all','--project','vision','--release',a,'--target-release','gpu-2='+b,'-g','4','--data','same@'+a,'--','python','train.py','--hosts','literal','--target-release','literal']);assert.equal(r.code,0,r.stderr);const request=f.calls.find(c=>c.operation==='jobs.submit').args;assert.deepEqual(request.hosts,['gpu-1','gpu-2']);assert.deepEqual(request.targetReleases,{'gpu-2':b});assert.equal(request.release,a);assert.deepEqual(request.argv,['python','train.py','--hosts','literal','--target-release','literal']);assert.deepEqual(request.datasets,[{dataset:'same',version:a}]);assert.equal(f.calls.some(c=>c.operation==='projects.status'),false);
});
test('mapping-only auto uses every explicitly supplied full release and never loads latest',async t=>{
  const f=await fixture(t),r=await f.cli(['run','auto','--hosts','gpu-1,gpu-2','--project','vision','--target-release','gpu-1='+a,'--target-release','gpu-2='+b,'--','true']);assert.equal(r.code,0,r.stderr);const args=f.calls.find(c=>c.operation==='jobs.submit').args;assert.equal('release' in args,false);assert.deepEqual(args.targetReleases,{'gpu-1':a,'gpu-2':b});assert.equal(f.calls.some(c=>c.operation==='projects.status'),false);
});
test('ambiguous fleet range, release maps and mixing fixed/auto flags fail before submit',async t=>{
  const f=await fixture(t);
  for(const args of [['run','auto'],['run','auto','--hosts','gpu-1,gpu-1'],['run','auto','--hosts','gpu-9'],['run','auto','--hosts','all','--project','vision'],['run','auto','--hosts','all','--project','vision','--target-release','gpu-1='+a],['run','gpu-1','--hosts','all'],['run','auto','--hosts','all','--target-release','gpu-1='+a],['run','auto','--hosts','gpu-1','--project','vision','--release',a,'--target-release','gpu-2='+b],['run','auto','--hosts','all','--machine','gpu-1']])assert.equal((await f.cli([...args,'--','true'])).code,1);
  assert.equal(f.calls.some(c=>c.operation==='jobs.submit'),false);
});
test('fixed project run retains its exact legacy wire and explicit current-machine selection',async t=>{
  const f=await fixture(t),r=await f.cli(['run','gpu-1','--','python','train.py']);assert.equal(r.code,0,r.stderr);const args=f.calls.find(c=>c.operation==='jobs.submit').args;assert.equal(args.machine,'gpu-1');assert.equal(args.project,'vision');assert.equal(args.release,a);assert.equal('hosts' in args||'targetReleases' in args,false);
});
