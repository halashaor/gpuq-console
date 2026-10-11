import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {PortalService} from '../portal-service.mjs';
import {createPortalServer} from '../portal-server.mjs';
import {downloadResultFile} from '../client-result-download.mjs';

const jobId='11111111-1111-4111-8111-111111111111',fingerprint='a'.repeat(64);
async function fixture(t,http=false,role='admin'){
  const dir=await mkdtemp(join(tmpdir(),'portal-result-')),bootstrap=join(dir,'bootstrap');
  const password='Only-Synthetic-Result-Test-2026!';
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}),{mode:0o600});
  const bytes=Buffer.alloc(1024**2+37,123),calls=[];
  const f={dir,bytes,calls,block:null,legacy:false};
  const bridge=async(machine,operation,args)=>{
    calls.push({machine,operation,args});assert.equal(operation,'files.get');
    if(f.block)await f.block;
    if(args.fingerprint&&args.fingerprint!==fingerprint)throw Error('Source fingerprint changed');
    const data=bytes.subarray(args.offset,args.offset+1024**2);
    return {protocol:f.legacy?1:2,path:args.path,size:bytes.length,offset:args.offset,data:data.toString('base64'),eof:args.offset+data.length===bytes.length,fingerprint,privatePath:'not-public'};
  };
  let service,server;
  if(http){
    const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;
    await new Promise(r=>reservation.close(r));
    ({service,server}=await createPortalServer({database:join(dir,'db'),bootstrap,origin:'http://127.0.0.1:'+port,secure:false,bridge}));
    await new Promise(r=>server.listen(port,'127.0.0.1',r));
  }else service=await PortalService.open(join(dir,'db'),bootstrap,undefined,bridge);
  for(const key of ['executionTimer','notificationTimer','maintenanceTimer','transferTimer','storageArchiveTimer','projectCopyTimer'])clearInterval(service[key]);
  const user=service.store.users[0];user.limits['gpu-1']=1;user.role=role;
  service.store.jobs.push({id:jobId,userId:user.id,machine:'gpu-1',project:'paper',state:'SUCCEEDED',name:'fixture',spec:{argv:['python','fixture.py']}});
  const login=await service.login('admin',password);
  t.after(async()=>{if(server?.listening)await new Promise(r=>server.close(r));if(!server)service.close();await rm(dir,{recursive:true,force:true});});
  return Object.assign(f,{service,server,user,token:login.token,args:{machine:'gpu-1',project:'paper',area:'output',runId:jobId,path:'summary.bin',offset:0}});
}
test('explicit result route uses bounded read lane and literal files.get; no state or private fields',async t=>{
  const f=await fixture(t);let release;const pending=new Promise(r=>release=r),write=f.service.enqueue(()=>pending);
  try{
    const result=await f.service.invoke(f.token,'files.result.get',f.args);
    assert.equal(result.result.protocol,2);assert.equal(Buffer.from(result.result.data,'base64').length,1024**2);
    assert.equal(result.result.privatePath,undefined);assert.equal(result.state,undefined);
    assert.equal(f.calls[0].args.userId,f.user.id);assert.equal(f.calls.length,1);
  }finally{release();await write;}
});
test('other owners including admin, wrong machine/project, code and injected identities never dispatch',async t=>{
  const f=await fixture(t);
  for(const patch of [{project:'other'},{machine:'gpu-2'},{runId:'22222222-2222-4222-8222-222222222222'},
    {area:'code'},{userId:'other'},{hostAdmin:true},{data:'YQ=='},{path:'../secret'},{path:'/etc/passwd'},{offset:-1},{fingerprint:[fingerprint]}])
    await assert.rejects(f.service.invoke(f.token,'files.result.get',{...f.args,...patch}));
  f.service.store.jobs[0].userId='another-owner';
  await assert.rejects(f.service.invoke(f.token,'files.result.get',f.args),e=>e.status===403);
  assert.equal(f.calls.length,0);
});
test('owned result reads remain available during operational maintenance',async t=>{
  const f=await fixture(t);
  await f.service.invoke(f.token,'maintenance.set',{scope:'all',enabled:true,revision:0,reason:'fixture'});
  const value=await f.service.invoke(f.token,'files.result.get',f.args);
  assert.equal(value.result.protocol,2);assert.equal(f.calls.length,1);
});
test('lost permission or changed job ownership during read discards late bytes',async t=>{
  for(const change of ['grant','owner']){
    const f=await fixture(t,false,'member');let release;f.block=new Promise(r=>release=r);
    const pending=f.service.invoke(f.token,'files.result.get',f.args);await new Promise(r=>setImmediate(r));
    if(change==='grant')f.user.limits['gpu-1']=0;else f.service.store.jobs[0].userId='another-owner';
    release();await assert.rejects(pending,e=>e.status===403);
  }
});
test('portal download resumes same receipt and verifies bytes; absent flag never selects portal',async t=>{
  const f=await fixture(t),destination=join(f.dir,'download.bin'),options={machine:'gpu-1',context:{project:'paper',area:'output',runId:jobId},path:'summary.bin',destination,origin:'https://portal.example',userId:f.user.id,via:'portal'};
  let interrupted=false;
  const call=async(operation,args)=>{
    assert.equal(operation,'files.result.get');
    if(args.offset===1024**2&&!interrupted){interrupted=true;throw Error('synthetic disconnect');}
    return f.service.invoke(f.token,operation,args);
  };
  await assert.rejects(downloadResultFile(call,options),/disconnect/);
  assert.equal((await lstat(destination)).size,1024**2);
  const before=f.calls.length,result=await downloadResultFile(call,options);
  assert.equal(result.resumed,true);assert.equal(f.calls[before].args.offset,1024**2);
  assert.equal(f.calls[before].args.fingerprint,fingerprint);
  assert.deepEqual(await readFile(destination),f.bytes);
  assert.equal(result.sha256,createHash('sha256').update(f.bytes).digest('hex'));
  let defaultCalls=0;
  await assert.rejects(downloadResultFile(()=>{throw Error('portal must not be called')},{...options,via:undefined},{directDownload:async()=>{defaultCalls++;throw Object.assign(Error('no campus'),{code:'CAMPUS_ENDPOINT_UNAVAILABLE'});}}),/--via portal/);
  assert.equal(defaultCalls,1);
});
test('legacy node and non-job contexts fail without creating a destination',async t=>{
  const f=await fixture(t);f.legacy=true;
  await assert.rejects(f.service.invoke(f.token,'files.result.get',f.args),e=>e.status===503);
  const destination=join(f.dir,'must-not-exist');
  await assert.rejects(downloadResultFile(()=>{throw Error('must not dispatch')},{via:'portal',context:{project:'paper',area:'code'},destination}));
  await assert.rejects(lstat(destination),e=>e.code==='ENOENT');
});
test('real CLI pull --via portal fetches job output through Portal HTTP',async t=>{
  const f=await fixture(t,true),{server}=f;
  const url='http://127.0.0.1:'+server.address().port,session=join(f.dir,'session.json'),destination=join(f.dir,'cli.bin');
  await writeFile(session,JSON.stringify({url,token:f.token,principal:{userId:f.user.id,username:'admin',role:'admin'}}),{mode:0o600});
  const result=await new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[new URL('../cli.mjs',import.meta.url).pathname,'pull','summary.bin',destination,'--via','portal','--job',jobId,'--project','paper','--machine','gpu-1','--url',url,'--session-file',session,'--json']);
    let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.once('error',reject);p.once('exit',code=>resolve({code,out,err}));
  });
  assert.equal(result.code,0,result.err);assert.deepEqual(await readFile(destination),f.bytes);
  assert.equal(f.calls.length,2);
});
