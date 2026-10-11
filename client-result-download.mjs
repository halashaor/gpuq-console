import {downloadFile} from './client-file-download.mjs';

export async function downloadResultFile(call,options,{directDownload=downloadFile}={}){
  const {via,...file}=options;
  if(via!==undefined&&via!=='portal')throw Error('结果下载可使用 --via portal；省略该选项使用原下载通道。');
  if(via==='portal'){
    if(file.context?.area!=='output'||!file.context.project||!file.context.runId)throw Error('门户下载仅用于 --job 指定的本人任务结果。');
    return downloadFile((operation,args)=>{
      if(operation!=='files.get')throw Error('Invalid result download operation');
      return call('files.result.get',args);
    },file);
  }
  try{return await directDownload(call,file);}
  catch(error){
    if(file.context?.area==='output'&&error.code==='CAMPUS_ENDPOINT_UNAVAILABLE')
      error.message+='\n校外可在原 pull 命令加 --via portal，经 HTTPS 门户下载同一任务结果。';
    throw error;
  }
}
