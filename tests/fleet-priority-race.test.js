import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';
const password='Fleet-Priority-Race-Fixture-2026!',caps=['priority-policy-v1','preempt-idle-only-v1','priority-rank-v1','fleet-admission-v2','console-fleet-v1'];
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-fleet-rank-race-')),bootstrap=join(dir,'bootstrap'),database=join(dir,'db'),status=join(dir,'status');await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,capabilities:caps,jobs:[]}}))}));
  const calls=[],handlers=new Map();let policy={priority:2,yield_policy:'never',restart_policy:'never',dispatch_mode:'queue'},priority='normal',jobId;
  const result=()=>({nodeJobId:'Jrace',state:'PENDING',assignedIndices:[],schedulerState:'QUEUED',priority,schedulerPriority:policy.priority,schedulerPolicy:{...policy},priorityMutable:true});
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args:structuredClone(args)});if(handlers.has(operation))return handlers.get(operation)(args);if(operation==='offer')return {kind:'idle',count:1};if(operation==='priority'){assert.equal(args.rankOnly,true);priority=args.priority;policy={...policy,priority:Number(args.priority.slice(1))};return result();}if(operation==='cancel')return {...result(),state:'CANCELED',priorityMutable:false};return {...result(),accepted:true};};
  const s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);s.reconciling=true;const admin=await s.login('admin',password),request={machine:'auto',hosts:['gpu-1'],cards:1,argv:['python','train.py'],priority:'normal',key:randomUUID()};jobId=(await s.invoke(admin.token,'jobs.submit',request)).result.id;
  const step=async()=>{s.reconciling=false;try{await s.reconcile();}finally{s.reconciling=true;}};await step();
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});const job=()=>s.store.jobs.find(j=>j.id===jobId);
  return {s,admin,request,jobId,job,calls,handlers,result,step,rank:()=>s.invoke(admin.token,'jobs.priority',{jobId,priority:'P1',expectedPriority:'normal'})};
}
for(const outcome of ['success','failure'])test(`old auto sync ${outcome} cannot overwrite a subsequently confirmed rank`,async t=>{
  const f=await fixture(t),entered=deferred(),reply=deferred(),before={spec:structuredClone(f.job().spec),digest:f.job().digest,request:structuredClone(f.job().request),token:f.job().routing.admissionKey};
  assert.equal(f.s.state(f.admin.principal).jobs[0].canSetPriority,true);const old=f.result();f.handlers.set('sync',async()=>{entered.resolve();return reply.promise;});const pending=f.step();await entered.promise;const ranked=(await f.rank()).result;assert.equal(ranked.priority,'P1');const revision=f.job().policyRevision;
  outcome==='success'?reply.resolve(old):reply.reject(Error('old sync transport failure'));await pending;
  assert.equal(f.job().priority,'P1');assert.equal(f.job().schedulerPriority,1);assert.equal(f.job().schedulerPolicy.priority,1);assert.equal(f.job().error,null);assert.equal(f.job().policyRevision,revision);assert.deepEqual(f.job().spec,before.spec);assert.deepEqual(f.job().request,before.request);assert.equal(f.job().digest,before.digest);assert.equal(f.job().routing.admissionKey,before.token);
  const saved=JSON.parse(f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0];assert.equal(saved.priority,'P1');assert.equal(f.s.state(f.admin.principal).jobs[0].canSetPriority,true);assert.equal(f.calls.filter(c=>c.operation==='admit').length,1);
});
for(const outcome of ['success','failure'])test(`old auto sync ${outcome} cannot overwrite rank-RPC uncertainty`,async t=>{
  const f=await fixture(t),entered=deferred(),reply=deferred(),old=f.result();f.handlers.set('sync',async()=>{entered.resolve();return reply.promise;});f.handlers.set('priority',async()=>{throw Error('priority reply lost');});const pending=f.step();await entered.promise;await assert.rejects(f.rank(),/priority reply lost/);const error=f.job().error,revision=f.job().policyRevision;assert.equal(f.job().priorityMutable,false);
  outcome==='success'?reply.resolve(old):reply.reject(Error('old sync transport failure'));await pending;assert.equal(f.job().error,error);assert.equal(f.job().priorityMutable,false);assert.equal(f.job().policyRevision,revision);assert.equal(f.job().state,'PENDING');assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);
});
for(const outcome of ['success','failure'])test(`old accepted auto sync ${outcome} respects a new cancellation transition`,async t=>{
  const f=await fixture(t),entered=deferred(),reply=deferred(),old={...f.result(),state:'RUNNING',assignedIndices:[0]};f.handlers.set('sync',async()=>{entered.resolve();return reply.promise;});const pending=f.step();await entered.promise;await f.s.invoke(f.admin.token,'jobs.cancel',{jobId:f.jobId});assert.equal(f.job().cancelRequested,true);
  outcome==='success'?reply.resolve(old):reply.reject(Error('old sync transport failure'));await pending;assert.equal(f.job().cancelRequested,true);assert.equal(f.job().state,'PENDING');assert.equal(f.job().error,null);assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);
  f.handlers.delete('sync');await f.step();assert.equal(f.job().state,'CANCELED');assert.equal(usage(f.s.store.jobs,'builtin-admin'),0);assert.equal(f.calls.filter(c=>c.operation==='admit').length,1);assert.equal(f.calls.find(c=>c.operation==='cancel').machine,'gpu-1');
});
