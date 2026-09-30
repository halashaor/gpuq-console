import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PortalService} from '../portal-service.mjs';
import {MACHINES} from '../dist/model.js';
import {usage} from '../execution.mjs';
const password='Cancel-Persistence-Fixture-2026!',caps=['priority-policy-v1','preempt-idle-only-v1','fleet-admission-v2','console-fleet-v1'];
async function fixture(t,mode){
  const dir=await mkdtemp(join(tmpdir(),'gpuq-cancel-persistence-')),database=join(dir,'db'),bootstrap=join(dir,'bootstrap'),status=join(dir,'status'),calls=[];await writeFile(bootstrap,JSON.stringify({username:'admin',password}));
  await writeFile(status,JSON.stringify({version:1,checkedAt:new Date().toISOString(),hosts:MACHINES.map(m=>({id:m.id,reachable:true,gpus:Array.from({length:m.cards},(_,index)=>({index,memoryTotalMiB:32768})),gpuq:{connected:true,observeOnly:false,capabilities:caps,jobs:[]}}))}));
  let drain=false,s,admin;
  const bridge=async(machine,operation,args)=>{calls.push({machine,operation,args:structuredClone(args)});if(operation==='offer')return {kind:'idle',count:1};if(['cancel','cancel-admission'].includes(operation))return {accepted:true,nodeJobId:'Jcancel',state:drain?'CANCELED':'UNKNOWN',assignedIndices:[]};return {accepted:true,nodeJobId:'Jcancel',state:'PENDING',assignedIndices:[]};};
  const open=async()=>{s=await PortalService.open(database,undefined,status,bridge);clearInterval(s.executionTimer);s.reconciling=true;admin=await s.login('admin',password);};
  s=await PortalService.open(database,bootstrap,status,bridge);clearInterval(s.executionTimer);s.reconciling=true;admin=await s.login('admin',password);
  const id=(await s.invoke(admin.token,'jobs.submit',{machine:mode==='fixed'?'gpu-1':'auto',...(mode==='fixed'?{}:{hosts:['gpu-1']}),cards:1,argv:['true'],key:randomUUID()})).result.id;
  const step=async()=>{s.reconciling=false;try{await s.reconcile();}finally{s.reconciling=true;}};if(mode==='accepted')await step();
  t.after(async()=>{s.close();await rm(dir,{recursive:true,force:true});});
  return {get s(){return s},get admin(){return admin},id,calls,step,job:()=>s.store.jobs.find(j=>j.id===id),cancel:()=>s.invoke(admin.token,'jobs.cancel',{jobId:id}),reopen:async()=>{s.close();await open();},drained:()=>{drain=true;}};
}
for(const mode of ['fixed','waiting','accepted'])for(const failure of ['save','audit'])test(`${mode} cancel ${failure} failure preserves the original object, durable state and quota after reopen`,async t=>{
  const f=await fixture(t,mode),job=f.job(),before=structuredClone(job),bytes=f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data,callCount=f.calls.length;let cleanups=0;f.s.pruneTaskNotes=()=>{cleanups++;return 0;};
  f.s.db.exec(failure==='save'?`CREATE TRIGGER fail_cancel BEFORE UPDATE ON portal_state WHEN instr(NEW.data,'"cancelRequested":true')>0 BEGIN SELECT RAISE(ABORT,'cancel save failure'); END`:`CREATE TRIGGER fail_cancel BEFORE INSERT ON audit WHEN NEW.operation='jobs.cancel' BEGIN SELECT RAISE(ABORT,'cancel audit failure'); END`);
  await assert.rejects(f.cancel(),new RegExp('cancel '+failure+' failure'));
  assert.equal(f.job(),job);assert.deepEqual(job,before);assert.equal(f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data,bytes);assert.equal(f.s.db.prepare("SELECT count(*) n FROM audit WHERE operation='jobs.cancel'").get().n,0);assert.equal(cleanups,0);assert.equal(f.calls.length,callCount);assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);
  const state=f.s.state(f.admin.principal).jobs.find(j=>j.id===f.id);assert.equal(state.state,before.state);assert.equal(state.cancelRequested,false);
  f.s.db.exec('DROP TRIGGER fail_cancel');await f.reopen();assert.equal(f.job().state,before.state);assert.equal(f.job().cancelRequested,false);assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);
});
test('committed WAITING_POOL cancellation is durable, cleans notes after commit, and terminal retries are noops',async t=>{
  const f=await fixture(t,'waiting');let cleanups=0;f.s.pruneTaskNotes=()=>{assert.equal(JSON.parse(f.s.db.prepare('SELECT data FROM portal_state WHERE id=1').get().data).jobs[0].state,'CANCELED');cleanups++;return 0;};
  assert.equal((await f.cancel()).result.state,'CANCELED');assert.equal(cleanups,1);assert.equal(f.calls.length,0);assert.equal(usage(f.s.store.jobs,'builtin-admin'),0);const first=structuredClone(f.job());
  assert.equal((await f.cancel()).result.state,'CANCELED');assert.deepEqual(f.job(),first);assert.equal(cleanups,1);assert.equal(f.s.db.prepare("SELECT count(*) n FROM audit WHERE operation='jobs.cancel'").get().n,1);await f.reopen();assert.equal(f.job().state,'CANCELED');assert.equal(usage(f.s.store.jobs,'builtin-admin'),0);
});
for(const mode of ['fixed','accepted'])test(`${mode} durable cancelRequested still reserves quota until the exact node confirms drain`,async t=>{
  const f=await fixture(t,mode),before=f.job().state;await f.cancel();assert.equal(f.job().cancelRequested,true);assert.equal(f.job().state,before);assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);await f.step();assert.equal(f.job().state,'UNKNOWN');assert.equal(usage(f.s.store.jobs,'builtin-admin'),1);f.drained();await f.step();assert.equal(f.job().state,'CANCELED');assert.equal(usage(f.s.store.jobs,'builtin-admin'),0);assert.equal(f.calls.filter(c=>['cancel','cancel-admission'].includes(c.operation)).every(c=>c.machine==='gpu-1'),true);
});
