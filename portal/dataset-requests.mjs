import {executionCall} from '../execution.mjs';
import {datasetLabelCall} from '../dataset-labels.mjs';
import {storageUsageCall} from '../storage-usage.mjs';
import {copyRequestArguments,sameIdentity} from './request-identity.mjs';

// Request orchestration only. Storage operations and node I/O remain in their
// own modules; this class owns the shared catalog lane and response lifecycle.
export class DatasetRequests{
  constructor(portal){this.portal=portal;}

  async catalogSlot(work,message='数据目录正在读取，请稍后刷新。'){
    const portal=this.portal;
    if(portal.datasetReadPending>=4)throw Object.assign(Error(message),{status:429});
    portal.datasetReadPending++;
    try{return await work();}finally{portal.datasetReadPending--;}
  }

  async read(token,operation,args){
    const portal=this.portal,request=copyRequestArguments(args);
    const admitted=portal.principal(token),policy=JSON.stringify(portal.store.get(admitted.userId));
    const check=()=>{
      if(portal.closing)throw Object.assign(Error('服务正在关闭。'),{status:503});
      const current=portal.principal(token);
      if(!sameIdentity(current,admitted)||JSON.stringify(portal.store.get(current.userId))!==policy)
        throw Object.assign(Error('账号授权已改变，请重新加载数据集。'),{status:403});
      return current;
    };
    check();
    return this.catalogSlot(async()=>{
      let result,current;
      try{
        portal.assertMaintenanceAllowed?.(operation,request,admitted);
        result=operation.startsWith('datasets.cache.')
          ?await portal.datasetCacheActionsCall(admitted,operation,request,check)
          :await executionCall(portal,admitted,operation,request);
      }finally{current=check();}
      return {result,principal:current};
    });
  }

  admissionStatus(token,operation,args){
    const portal=this.portal,request=copyRequestArguments(args),principal=portal.principal(token);
    // Recovery reads the existing journal, never waits for or replays begin.
    return executionCall(portal,principal,operation,request).then(result=>{
      const current=portal.principal(token);
      if(!sameIdentity(current,principal))throw Object.assign(Error('登录身份已改变。'),{status:403});
      return {result,principal:{...current}};
    });
  }

  labels(token,operation,args){
    const portal=this.portal,principal=portal.principal(token);
    return this.catalogSlot(()=>datasetLabelCall(portal,principal,operation,args,()=>portal.principal(token))
      .then(result=>({result,principal:portal.principal(token)})));
  }

  delete(token,operation,args){
    const portal=this.portal,request=copyRequestArguments(args),principal=portal.principal(token);
    const check=()=>{
      if(!sameIdentity(portal.principal(token),principal))throw Object.assign(Error('登录身份已改变。'),{status:403});
    };
    return portal.datasetDeletionCall(principal,operation,request,check).then(result=>{
      check();return {result,principal:{...principal}};
    });
  }

  usage(token,operation,args){
    const portal=this.portal,principal=portal.principal(token),policy=JSON.stringify(portal.store.get(principal.userId));
    const check=()=>{
      const current=portal.principal(token);
      if(portal.closing||!sameIdentity(current,principal)||JSON.stringify(portal.store.get(current.userId))!==policy)
        throw Object.assign(Error('账号授权已改变，请刷新后重试。'),{status:403});
      return current;
    };
    portal.assertMaintenanceAllowed?.(operation,args,principal);
    return this.catalogSlot(()=>storageUsageCall(portal,principal,operation,args).then(result=>({result,principal:check()})),
      '空间统计正在读取，请稍后刷新。');
  }
}
