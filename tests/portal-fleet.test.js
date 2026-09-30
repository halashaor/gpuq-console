import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';
const caps=['priority-policy-v1','preempt-idle-only-v1','priority-rank-v1','preempt-opt-in-only-v1','console-yield-v1','console-elastic-v1','console-placement-v1','fleet-admission-v2','console-fleet-v1'];
const release='a'.repeat(64),other='b'.repeat(64),password='Portal-Fleet-Fixture-2026!';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-fleet-')),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),calls=[];
  await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  const hosts=MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,capabilities:caps,jobs:[]}}));
  const refresh=()=>writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts}));await refresh();
  let handler=async(machine,op,args)=>op==='offer'?{kind:'idle',count:args.job.elastic?args.job.elastic.minCards:args.job.cards}:op==='admit'?{accepted:true,nodeJobId:'native-'+args.job.id,state:'RUNNING',assignedIndices:[0]}:op==='sync'||op==='cancel'?{nodeJobId:'native-'+args.job.id,state:op==='cancel'?'CANCELED':'RUNNING',assignedIndices:op==='cancel'?[]:[0]}:op==='projects.verify'?{state:'READY',project:args.project,release:args.release}:op==='datasets.status'?{state:'READY',dataset:args.dataset,version:args.version}:{accepted:false,state:'CANCELED'};
  const bridge=async(machine,op,args)=>{calls.push({machine,op,args:structuredClone(args)});return handler(machine,op,args);};
  const service=await PortalService.open(join(dir,'db'),bootstrap,status,bridge);clearInterval(service.executionTimer);service.reconciling=true;
  const admin=await service.login('admin',password),member=(await service.invoke(admin.token,'users.create',{username:'alice',password})).result;
  await service.invoke(admin.token,'policy.save',{userId:member.id,policyVersion:0,total:16,limits:{'gpu-1':8,'gpu-2':8}});const login=await service.login('alice',password);
  const call=(operation,args={},token=login.token)=>service.invoke(token,operation,args),submit=(args={},token=login.token)=>call('jobs.submit',{machine:'auto',hosts:['gpu-1','gpu-2'],cards:1,argv:['python','train.py'],key:randomUUID(),...args},token);
  const step=async()=>{service.reconciling=false;await service.reconcile();service.reconciling=true;};
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});return {service,calls,hosts,admin,member,login,call,submit,step,refresh,handler:fn=>{handler=fn;}};
}
test('automatic requests are durably waiting before node RPC and private routing never leaks',async t=>{
  const f=await fixture(t),key=randomUUID(),args={key,hosts:['gpu-1'],project:'vision',targetReleases:{'gpu-1':release}};
  const a=(await f.submit(args)).result,b=(await f.submit(args)).result;assert.equal(a.id,b.id);assert.equal(a.state,'WAITING_POOL');assert.equal(a.machine,null);assert.deepEqual(a.command,['python','train.py']);assert.equal('request' in a||'routing' in a||'spec' in a,false);assert.equal(f.calls.length,0);
  const stored=f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data;assert.match(stored,/WAITING_POOL/);assert.match(stored,/targetReleases/);
  await assert.rejects(f.submit({...args,hosts:['gpu-2'],targetReleases:{'gpu-2':release}}),e=>e.status===409);
  for(const extra of [{hosts:undefined},{hosts:[]},{hosts:['gpu-1','gpu-1']},{hosts:['gpu-3']},{hosts:['gpu-1'],project:'vision',targetReleases:{'gpu-2':release}},{hosts:['gpu-1'],project:'vision',targetReleases:undefined},{placement:{gpuIndices:[0],shared:true,vramMiB:100}}])await assert.rejects(f.submit(extra));
  assert.equal((await f.call('jobs.watch',{jobId:a.id})).result.state,'WAITING_POOL');assert.match((await f.call('jobs.logs',{jobId:a.id})).result.text,/尚未选择/);assert.equal(f.calls.length,0);
});
test('idle on any prepared node is chosen before eligible preemption; queue requester may preempt volunteers',async t=>{
  const f=await fixture(t);f.handler(async(host,op,args)=>op==='offer'?host==='gpu-2'?{kind:'idle',count:1}:args.allowPreempt?{kind:'preempt',count:1}:{kind:'busy',count:0}:op==='admit'?{accepted:true,state:'RUNNING',nodeJobId:'J1',assignedIndices:[0]}:{state:'RUNNING',nodeJobId:'J1'});
  const id=(await f.submit()).result.id;await f.step();assert.equal(f.service.store.jobs.find(j=>j.id===id).machine,'gpu-2');assert.equal(f.calls.find(c=>c.op==='admit').args.allowPreempt,false);assert.equal(f.calls.some(c=>c.op==='offer'&&c.args.allowPreempt),false);
  const second=(await f.submit({hosts:['gpu-1']})).result.id;await f.step();assert.equal(f.service.store.jobs.find(j=>j.id===second).routing.allowPreempt,true);
});
test('higher ranked feasible wait blocks only its prepared hosts, not a server missing that project',async t=>{
  const f=await fixture(t);f.handler(async(host,op,args)=>op==='projects.verify'?{project:args.project,release:args.release,state:host==='gpu-1'?'DRAFT':'READY'}:op==='offer'?host==='gpu-2'?{kind:'busy',count:0}:{kind:'idle',count:1}:op==='admit'?{accepted:true,state:'RUNNING',nodeJobId:'Jlow',assignedIndices:[0]}:{state:'RUNNING',nodeJobId:'Jlow'});
  const low=(await f.submit({scheduling:{rank:'P0'}})).result.id,high=(await f.submit({project:'vision',release,scheduling:{rank:'P1'}})).result.id;await f.step();assert.equal(f.service.store.jobs.find(j=>j.id===high).state,'WAITING_POOL');assert.equal(f.service.store.jobs.find(j=>j.id===low).machine,'gpu-1');assert.equal(f.calls.filter(c=>c.op==='admit').length,1);
});
test('higher rank is offered first, and a prepared high waiter prevents lower backfill on the same host',async t=>{
  const f=await fixture(t);f.handler(async(host,op,args)=>op==='offer'?args.job.name==='high'?{kind:'busy',count:0,reason:'need gang'}:{kind:'idle',count:1}:op==='admit'?{accepted:true,state:'RUNNING',nodeJobId:'J',assignedIndices:[0]}:{});
  const low=(await f.submit({hosts:['gpu-1'],name:'low',scheduling:{rank:'P0'}})).result.id,high=(await f.submit({hosts:['gpu-1'],name:'high',cards:4,scheduling:{rank:'P1'}})).result.id;await f.step();assert.equal(f.calls.find(c=>c.op==='offer').args.job.id,high);assert.equal(f.calls.some(c=>c.op==='offer'&&c.args.job.id===low),false);assert.equal(f.calls.some(c=>c.op==='admit'),false);
});
test('per-node releases and exact owner-only dataset refs preflight without choosing latest or rewriting argv',async t=>{
  const f=await fixture(t),refs=[{dataset:'same-name',version:release}];f.handler(async(host,op,args)=>op==='projects.verify'?{state:'READY',project:args.project,release:args.release}:op==='datasets.status'?{state:host==='gpu-1'?'REGISTERED':'READY',dataset:args.dataset,version:args.version}:op==='offer'?{kind:'idle',count:1}:op==='admit'?{accepted:true,state:'RUNNING',nodeJobId:'J',assignedIndices:[0]}:{});
  const job=(await f.submit({project:'vision',release,targetReleases:{'gpu-2':other},datasets:refs,argv:['python','train.py','--data','/data2/same-name']})).result;await f.step();const admit=f.calls.find(c=>c.op==='admit');assert.equal(admit.machine,'gpu-2');assert.equal(admit.args.job.release,other);assert.deepEqual(admit.args.job.datasets,refs);assert.deepEqual(admit.args.job.argv,job.command);assert.equal(f.calls.filter(c=>c.op==='datasets.status').every(c=>c.args.userId===f.member.id&&c.args.hostAdmin===false),true);
});
test('lost admission replies retain the exact target/token/spec through retry and process reopen',async t=>{
  const f=await fixture(t);let fail=true;f.handler(async(host,op,args)=>op==='offer'?{kind:'idle',count:1}:op==='admit'&&fail?Promise.reject(Error('lost after accept')):{accepted:true,state:'RUNNING',nodeJobId:'J',assignedIndices:[0]});
  const id=(await f.submit()).result.id;await f.step();let job=f.service.store.jobs.find(j=>j.id===id);assert.equal(job.state,'UNKNOWN');assert.equal(usage(f.service.store.jobs,f.member.id),1);const first=f.calls.find(c=>c.op==='admit');
  f.service.restore(JSON.parse(f.service.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data));f.hosts[0].reachable=false;await f.refresh();fail=false;await f.step();job=f.service.store.jobs.find(j=>j.id===id);assert.equal(job.state,'RUNNING');const retries=f.calls.filter(c=>c.op==='admit');assert.equal(retries.length,2);assert.deepEqual(retries[1],first);assert.equal(f.calls.some(c=>c.op==='admit'&&c.machine==='gpu-2'),false);assert.equal('routing' in (await f.call('jobs.watch',{jobId:id})).result,false);
});
test('only durable rejection releases binding and permits another selected host',async t=>{
  const f=await fixture(t);let rejected=false;f.handler(async(host,op,args)=>op==='offer'?rejected&&host==='gpu-1'?{kind:'busy',count:0}:{kind:'idle',count:1}:op==='admit'&&host==='gpu-1'?(rejected=true,{accepted:false,state:'REJECTED',reason:'race lost'}):{accepted:true,state:'RUNNING',nodeJobId:'J',assignedIndices:[0]});
  const id=(await f.submit()).result.id;await f.step();assert.equal(f.service.store.jobs.find(j=>j.id===id).machine,null);await f.step();assert.equal(f.service.store.jobs.find(j=>j.id===id).machine,'gpu-2');const attempts=f.calls.filter(c=>c.op==='admit');assert.notEqual(attempts[0].args.admissionKey,attempts[1].args.admissionKey);
});
test('cancel waiting is local; cancel selected uncertain admission retains quota until tombstone or drain confirmed',async t=>{
  const f=await fixture(t),waiting=(await f.submit()).result;const canceled=(await f.call('jobs.cancel',{jobId:waiting.id})).result;assert.equal(canceled.state,'CANCELED');assert.equal(f.calls.length,0);assert.equal(usage(f.service.store.jobs,f.member.id),0);
  let drained=false;f.handler(async(host,op,args)=>op==='offer'?{kind:'idle',count:1}:op==='admit'?Promise.reject(Error('lost')):op==='cancel-admission'?drained?{accepted:false,state:'CANCELED'}:{accepted:true,state:'UNKNOWN',nodeJobId:'J'}:op==='cancel'?drained?{state:'CANCELED',nodeJobId:'J'}:{state:'UNKNOWN',nodeJobId:'J'}:{});
  const job=(await f.submit()).result;await f.step();const original=f.calls.find(c=>c.op==='admit');await f.call('jobs.cancel',{jobId:job.id});await f.step();assert.deepEqual(f.calls.find(c=>c.op==='cancel-admission').args,original.args);assert.equal(usage(f.service.store.jobs,f.member.id),1);drained=true;await f.step();assert.equal(usage(f.service.store.jobs,f.member.id),0);assert.equal(f.service.store.jobs.find(j=>j.id===job.id).state,'CANCELED');
});
test('static elastic ceiling survives low idle count and waits for own reserved quota rather than shrinking permanently',async t=>{
  const f=await fixture(t),elastic={minCards:1,globalBatch:32,microBatch:2,autoExpand:true},scheduling={rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true};
  f.service.store.jobs.push({id:'old',userId:f.member.id,machine:'gpu-1',cards:3,state:'RUNNING',spec:{id:'old',argv:['old']}});let oldFinished=false;f.handler(async(host,op,args)=>args.job.id==='old'?{state:oldFinished?'SUCCEEDED':'RUNNING',nodeJobId:'Jold',assignedIndices:oldFinished?[]:[0,1,2]}:op==='offer'?{kind:'idle',count:1}:{accepted:true,state:'RUNNING',nodeJobId:'Jelastic',assignedIndices:[0]});
  const id=(await f.submit({hosts:['gpu-1'],cards:8,elastic,scheduling})).result.id;await f.step();assert.equal(f.service.store.jobs.find(j=>j.id===id).state,'WAITING_POOL');oldFinished=true;await f.step();const job=f.service.store.jobs.find(j=>j.id===id);assert.equal(job.spec.cards,8);assert.equal(job.targetCards,8);assert.equal(job.spec.elastic.autoExpand,true);assert.equal(usage(f.service.store.jobs,f.member.id,'gpu-1'),8);
});
test('single legal static cap is explicitly effective nonexpanding, while global quota reserves original maximum',async t=>{
  const f=await fixture(t);const member=f.service.store.users.find(u=>u.id===f.member.id);member.limits['gpu-1']=2;f.service.save();
  const job=(await f.submit({hosts:['gpu-1'],cards:8,elastic:{minCards:2,globalBatch:16,microBatch:2,autoExpand:true},scheduling:{rank:'P1',yieldPolicy:'save',restartPolicy:'on-preempt',checkpointable:true}})).result;await f.step();const stored=f.service.store.jobs.find(j=>j.id===job.id);assert.equal(stored.spec.cards,2);assert.equal(stored.spec.elastic.autoExpand,false);assert.equal(stored.request.elastic.autoExpand,true);assert.equal(usage(f.service.store.jobs,f.member.id),8);assert.equal(usage(f.service.store.jobs,f.member.id,'gpu-1'),2);const view=f.service.state(f.login.principal).jobs.find(j=>j.id===job.id);assert.equal(view.targetCards,2);assert.equal(view.effectiveAutoExpand,false);assert.deepEqual(view.allowedGpuCounts,[2]);
});
test('admin implicit full access is honored during delayed placement, and concurrent retries create one reservation',async t=>{
  const f=await fixture(t),args={machine:'auto',hosts:['gpu-3'],cards:1,argv:['true'],key:randomUUID()},responses=await Promise.all([f.call('jobs.submit',args,f.admin.token),f.call('jobs.submit',args,f.admin.token)]);assert.equal(responses[0].result.id,responses[1].result.id);await f.step();assert.equal(f.service.store.jobs.find(j=>j.id===responses[0].result.id).machine,'gpu-3');assert.equal(f.calls.filter(c=>c.op==='admit').length,1);
});
test('binding persistence failure restores memory and never sends an unpersisted admission token',async t=>{
  const f=await fixture(t),id=(await f.submit()).result.id,save=f.service.save.bind(f.service);let fail=true;f.service.save=()=>{if(fail&&f.service.store.jobs.some(j=>j.id===id&&j.routing?.target))throw Error('binding disk failure');return save();};await assert.rejects(f.step(),/binding disk failure/);const job=f.service.store.jobs.find(j=>j.id===id);assert.equal(job.routing.target,null);assert.equal(job.spec,null);assert.equal(f.calls.some(c=>c.op==='admit'),false);fail=false;await f.step();assert.equal(f.calls.filter(c=>c.op==='admit').length,1);
});
test('cancellation during offer happens before binding and cannot launch a canceled task',async t=>{
  const f=await fixture(t);let entered,releaseOffer;const held=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>releaseOffer=resolve);f.handler(async(host,op,args)=>{if(op==='offer'){entered();await resume;return {kind:'idle',count:1};}throw Error('Should not dispatch');});const id=(await f.submit({hosts:['gpu-1']})).result.id,running=f.step();await held;await f.call('jobs.cancel',{jobId:id});releaseOffer();await running;assert.equal(f.service.store.jobs.find(j=>j.id===id).state,'CANCELED');assert.equal(f.calls.some(c=>c.op==='admit'),false);
});
test('higher priority arriving during offer is checked before the lower job can bind',async t=>{
  const f=await fixture(t);let entered,releaseOffer,once=true;const held=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>releaseOffer=resolve);f.handler(async(host,op,args)=>{if(op==='offer'){if(once){once=false;entered();await resume;}return {kind:'idle',count:1};}return {accepted:true,state:'RUNNING',nodeJobId:'J'+args.job.name,assignedIndices:[0]};});await f.submit({hosts:['gpu-1'],name:'low',scheduling:{rank:'P0'}});const running=f.step();await held;await f.submit({hosts:['gpu-1'],name:'high',scheduling:{rank:'P1'}});releaseOffer();await running;assert.equal(f.calls.some(c=>c.op==='admit'),false);await f.step();assert.equal(f.calls.find(c=>c.op==='admit').args.job.name,'high');
});
test('cancel during the outbound admit keeps the confirmed task fenced until exact-node cancellation',async t=>{
  const f=await fixture(t);let entered,releaseAdmit;const held=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>releaseAdmit=resolve);f.handler(async(host,op,args)=>{if(op==='offer')return {kind:'idle',count:1};if(op==='admit'){entered();await resume;return {accepted:true,state:'RUNNING',nodeJobId:'Jlate',assignedIndices:[0]};}if(op==='cancel')return {state:'CANCELED',nodeJobId:'Jlate',assignedIndices:[]};throw Error('Unexpected operation');});const id=(await f.submit({hosts:['gpu-1']})).result.id,running=f.step();await held;await f.call('jobs.cancel',{jobId:id});releaseAdmit();await running;assert.equal(usage(f.service.store.jobs,f.member.id),1);assert.equal(f.service.store.jobs.find(j=>j.id===id).cancelRequested,true);await f.step();assert.equal(usage(f.service.store.jobs,f.member.id),0);assert.equal(f.calls.find(c=>c.op==='cancel').machine,'gpu-1');
});
test('task-note cleanup failure cannot replace a confirmed training failure and retries after recovery',async t=>{
  const f=await fixture(t);f.handler(async(host,op,args)=>op==='offer'?{kind:'idle',count:1}:{accepted:true,state:'FAILED',nodeJobId:'Jfailed',error:'CUDA out of memory',assignedIndices:[]});let fail=true;f.service.pruneTaskNotes=()=>{if(fail)throw Error('GC storage failure');return 0;};const id=(await f.submit()).result.id;await f.step();const job=f.service.store.jobs.find(j=>j.id===id);assert.equal(job.state,'FAILED');assert.equal(job.error,'CUDA out of memory');assert.equal(f.service.noteCleanupPending,true);fail=false;await f.step();assert.equal(f.service.noteCleanupPending,false);assert.equal(job.error,'CUDA out of memory');
});
