import {MACHINES} from './dist/model.js';
import {validateProjectFile} from './projects.mjs';

const fields=new Set(['machine','project','area','runId','path','offset','fingerprint']);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};

// An explicit Portal read of an owned job output. This is not an upload route
// and never grants access to another owner's output or to a host path.
export async function resultFileDownload(service,principal,args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!fields.has(key)))fail('结果下载参数无效。');
  if(args.area!=='output'||!args.project)fail('门户下载仅支持指定项目和任务的结果文件。');
  validateProjectFile(args);
  const offset=args.offset??0;
  if(!Number.isSafeInteger(offset)||offset<0||typeof args.path!=='string'||!args.path||Buffer.byteLength(args.path)>4096
    ||args.path.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(args.path)||args.path.split('/').includes('..'))fail('结果文件路径或偏移无效。');
  if(args.fingerprint!==undefined&&(typeof args.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(args.fingerprint)))fail('下载文件身份无效。');
  const check=()=>{
    const user=service.store.get(principal.userId),job=service.store.jobs.find(row=>row.id===args.runId);
    if(!user.enabled||!MACHINES.some(row=>row.id===args.machine)||!user.limits?.[args.machine])fail('这台机器未授权。',403);
    if(!job||job.userId!==principal.userId||job.machine!==args.machine||job.project!==args.project)fail('任务输出不属于当前用户、项目或服务器。',403);
  };
  check();
  const value=await service.bridge(args.machine,'files.get',{...args,offset,userId:principal.userId});
  check();
  if(value?.protocol!==2||typeof value.fingerprint!=='string'||! /^[a-f0-9]{64}$/.test(value.fingerprint))fail('节点尚未确认可续传的结果下载协议。',503);
  if(value.path!==args.path||value.offset!==offset||typeof value.data!=='string'||value.data.length>Math.ceil(1024**2/3)*4)fail('节点结果文件回执无效。',502);
  return Object.fromEntries(['protocol','path','size','offset','data','eof','fingerprint'].map(key=>[key,value[key]]));
}
