import {randomUUID} from 'node:crypto';
import {MACHINES} from './dist/model.js';
import {createSubmittedJob} from './job-submission.mjs';
import {elasticCapable,placementCapable} from './dist/gpu-allocation.js';
import {yieldCapable} from './dist/scheduling-policy.js';
import {maintainTaskNotes} from './community.mjs';
import {fleetCapable} from './dist/fleet-selection.js';
export {fleetCapable} from './dist/fleet-selection.js';

export const isAutomatic=job=>job.request?.machine==='auto';
const terminal=new Set(['SUCCEEDED','FAILED','CANCELED']);
const rank=job=>Number(job.request?.explicit?.rank?.slice(1)??({idle:0,normal:2,high:4}[job.request?.priority]??2));
const clean=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,180):'暂无合适空位';

export function createAutomaticJob(request,user){
  const job=createSubmittedJob(request,user,true);
  return {...job,machine:null,spec:null,request:structuredClone(request),candidateHosts:[...request.hosts],
    routing:{target:null,specs:{}},state:'WAITING_POOL',queueReason:'等待候选服务器中符合要求的空位。'};
}

export function installFleetRouting(service,{schedulerResult,priorityCapable,usage}){
  const current=id=>service.store.jobs.find(j=>j.id===id);
  const account=id=>service.store.users.some(u=>u.id===id)?service.store.get(id):null;
  const bound=job=>isAutomatic(job)&&!!job.routing?.target;
  async function update(id,fn){return service.enqueue(()=>{
    const job=current(id);if(!job||service.closing)return;const before=structuredClone(job);let value;
    try{value=fn(job);service.save();}
    catch(error){for(const key of Object.keys(job))delete job[key];Object.assign(job,before);throw error;}
    maintainTaskNotes(service);
    return value;
  });}
  async function reconcileBound(job){
    const route=structuredClone(job.routing),spec=structuredClone(job.spec),accepted=route.accepted===true;
    const operation=accepted?(job.cancelRequested?'cancel':'sync'):(job.cancelRequested?'cancel-admission':'admit');
    try{
      const result=await service.bridge(route.target,operation,{job:spec,...(!accepted?{admissionKey:route.admissionKey,allowPreempt:route.allowPreempt}:{})});
      await update(job.id,current=>{
        if(current.routing?.admissionKey!==route.admissionKey||terminal.has(current.state))return;
        if(!accepted&&current.routing.accepted===true&&result.accepted===false){current.state='UNKNOWN';current.error='节点回执与已确认接纳的任务不一致，将继续在原节点核对。';return;}
        if(!accepted&&result.accepted===false&&['REJECTED','CANCELED'].includes(result.state)){
          if(current.cancelRequested||result.state==='CANCELED'){
            current.state='CANCELED';current.finishedAt=new Date().toISOString();current.queueReason='节点已确认未接纳并封存这项请求。';
          }else{
            current.routing={target:null,specs:current.routing.specs};current.machine=null;current.spec=null;delete current.targetCards;delete current.effectiveAutoExpand;
            current.state='WAITING_POOL';current.queueReason='节点原子拒绝：'+clean(result.reason);
          }
          current.error=null;return;
        }
        if(!accepted&&result.accepted!==true){current.state='UNKNOWN';current.error='接纳结果未确认，将继续核对同一服务器和同一提交键。';return;}
        current.routing.accepted=true;schedulerResult(current,result);
      });
    }catch(error){await update(job.id,current=>{if(current.routing?.admissionKey===route.admissionKey&&!terminal.has(current.state)){current.state='UNKNOWN';current.checkedAt=new Date().toISOString();current.error='节点接纳或状态核对未确认，将继续使用原服务器与原提交键。';}});}
  }

  async function prepare(job,hostId){
    const request=job.request,user=account(job.userId),host=service.gpuq?.hosts.find(h=>h.id===hostId),physical=MACHINES.find(m=>m.id===hostId);
    if(!user?.enabled||!user.limits[hostId])return {reason:'账号或服务器授权不可用'};
    if(service.gpuq?.stale||!fleetCapable(host)||!priorityCapable(host))return {reason:'节点状态或多机接纳能力未确认'};
    if(request.explicit&&!yieldCapable(host)||request.explicit?.mode&&request.explicit.mode!=='queue'&&!host.gpuq.capabilities.includes('preempt-opt-in-only-v1'))return {reason:'请求的调度策略尚未接通'};
    if(request.elastic&&!elasticCapable(host)||request.placement&&!placementCapable(host,request.placement))return {reason:'弹性或选卡能力尚未接通'};
    const eligible=(host.gpus||[]).filter(g=>g.memoryTotalMiB>=request.minVramGiB*1024-512);
    if(request.placement&&request.placement.gpuIndices.some(i=>!eligible.some(g=>g.index===i)))return {reason:'指定显卡不存在或显存不足'};
    const cap=Math.min(request.cards,physical.cards,user.limits[hostId]);
    const legal=request.elastic?request.allowedGpuCounts.filter(n=>n<=cap):[request.cards].filter(n=>n<=cap);
    if(!legal.length)return {reason:'本机静态容量、额度或显存不足最低卡数'};
    if(eligible.length<Math.min(...legal))return {reason:'可核验显卡数量或显存不足最低卡数'};
    let targetCards=Math.max(...legal),effectiveAutoExpand=request.elastic?.autoExpand===true&&legal.length>1;
    let spec=job.routing?.specs?.[hostId]?.spec;
    if(spec){
      if(spec.cards>cap)return {reason:'先前固定请求不符合当前本机额度'};
      targetCards=spec.cards;effectiveAutoExpand=spec.elastic?.autoExpand===true;
    }else{
      const project=request.project.project?{project:request.project.project,release:request.targetReleases?.[hostId]||request.project.release}:{};
      spec=createSubmittedJob({...request,machine:hostId,cards:targetCards,project,...(request.elastic?{elastic:{...request.elastic,autoExpand:effectiveAutoExpand}}:{})},user,true,{id:job.id,now:job.createdAt}).spec;
    }
    if(usage(service.store.jobs,user.id,hostId)+targetCards>user.limits[hostId])return {reason:'本机个人预留额度尚未释放'};
    if(spec.project){
      try{const ready=await service.bridge(hostId,'projects.verify',{project:spec.project,release:spec.release,userId:user.id});if(ready.state!=='READY'||ready.project!==spec.project||ready.release!==spec.release)return {reason:'固定项目版本未就绪'};}
      catch{return {reason:'固定项目版本或当前环境无法核验'};}
    }
    for(const ref of spec.datasets||[]){
      try{const ready=await service.bridge(hostId,'datasets.status',{...ref,userId:user.id,hostAdmin:false});if(ready.state!=='READY'||ready.dataset!==ref.dataset||ready.version!==ref.version)return {reason:'指定名称与版本的数据未就绪'};}
      catch{return {reason:'个人数据授权或固定数据版本无法核验'};}
    }
    return {host:hostId,spec,targetCards,effectiveAutoExpand,staticCap:cap};
  }

  async function routeWaiting(){
    await service.refreshGPUQ();
    const waiting=service.store.jobs.map((job,index)=>({job,index})).filter(({job})=>isAutomatic(job)&&!bound(job)&&!terminal.has(job.state)).sort((a,b)=>rank(b.job)-rank(a.job)||a.index-b.index),preparedByJob=new Map();
    // An unresolved selected admission is not idle capacity, even if a metrics
    // snapshot has not yet seen its native lease. Other servers keep working.
    const blocked=new Set(service.store.jobs.filter(job=>bound(job)&&job.routing.accepted!==true&&!terminal.has(job.state)).map(job=>job.machine));
    for(const {job} of waiting){
      if(service.closing)break;
      if(job.cancelRequested){await update(job.id,current=>{if(!bound(current)){current.state='CANCELED';current.finishedAt=new Date().toISOString();}});continue;}
      const prepared=[],reasons=[];
      for(const host of job.candidateHosts){
        if(blocked.has(host)){reasons.push(host+': 等待较早或较高优先级的可运行任务');continue;}
        const candidate=await prepare(job,host);if(candidate.spec)prepared.push(candidate);else reasons.push(host+': '+candidate.reason);
      }
      preparedByJob.set(job.id,new Set(prepared.map(c=>c.host)));
      if(job.cancelRequested||terminal.has(job.state)||service.closing)continue;
      let winner=null;
      for(const allowPreempt of [false,true]){
        const offers=[];
        for(const candidate of prepared){
          try{const offer=await service.bridge(candidate.host,'offer',{job:candidate.spec,allowPreempt});
            if(['idle','preempt'].includes(offer.kind)&&Number.isInteger(offer.count)&&offer.count>0&&offer.count<=candidate.targetCards&&(!job.request.elastic?offer.count===candidate.targetCards:job.request.allowedGpuCounts.includes(offer.count))&&(!allowPreempt?offer.kind==='idle':true))offers.push({...candidate,count:offer.count,allowPreempt:offer.kind==='preempt'});
            else if(!allowPreempt)reasons.push(candidate.host+': '+clean(offer.reason));
          }catch{if(!allowPreempt)reasons.push(candidate.host+': 无法核验实时空位');}
        }
        if(offers.length){offers.sort((a,b)=>b.count-a.count);winner=offers[0];break;}
      }
      if(!winner){for(const candidate of prepared)blocked.add(candidate.host);await update(job.id,current=>{if(!bound(current)&&!terminal.has(current.state)){current.state='WAITING_POOL';current.queueReason=reasons.join('；').slice(0,400)||'等待候选服务器空位。';}});continue;}
      const selected=await update(job.id,current=>{
        const user=account(current.userId);
        if(bound(current)||terminal.has(current.state)||current.cancelRequested||!user?.enabled||!user.limits[winner.host]||usage(service.store.jobs,user.id,winner.host)+winner.targetCards>user.limits[winner.host])return false;
        if(!current.routing.specs[winner.host]&&Math.min(current.request.cards,MACHINES.find(m=>m.id===winner.host).cards,user.limits[winner.host])!==winner.staticCap){service.fleetNeedsAnotherPass=true;return false;}
        const position=service.store.jobs.indexOf(current);
        const superseding=service.store.jobs.some((other,index)=>other!==current&&isAutomatic(other)&&!bound(other)&&!terminal.has(other.state)&&!other.cancelRequested&&other.candidateHosts.includes(winner.host)&&(rank(other)>rank(current)||rank(other)===rank(current)&&index<position)&&(!preparedByJob.has(other.id)||preparedByJob.get(other.id).has(winner.host)));
        if(superseding){current.queueReason='新的较高优先级任务进入候选范围，先核验其可运行节点。';service.fleetNeedsAnotherPass=true;return false;}
        current.routing={target:winner.host,admissionKey:randomUUID(),allowPreempt:winner.allowPreempt,accepted:null,specs:{...current.routing.specs,[winner.host]:{spec:structuredClone(winner.spec)}}};
        current.machine=winner.host;current.spec=structuredClone(winner.spec);current.targetCards=winner.targetCards;current.effectiveAutoExpand=winner.effectiveAutoExpand;
        if(current.spec.release)current.release=current.spec.release;
        current.state='SUBMITTING';current.queueReason='已固定服务器，正在原子接纳。';current.error=null;
        return true;
      });
      if(selected){await reconcileBound(current(job.id));if(current(job.id)?.routing?.target&&current(job.id).routing.accepted!==true)blocked.add(winner.host);}
    }
  }
  service.reconcileFleet=async()=>{
    for(const job of service.store.jobs.filter(job=>bound(job)&&!terminal.has(job.state)))await reconcileBound(job);
    await routeWaiting();
  };
}
