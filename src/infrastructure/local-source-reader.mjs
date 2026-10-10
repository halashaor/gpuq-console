import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {ApplicationError} from '../domain/errors.mjs';

/**
 * catalog.find(request) supplies an authorized source binding from trusted
 * node configuration/catalogue: {hostPath, ready?}. No request contains a path.
 * A managed version needs its catalogue's READY proof as well as a directory.
 */
export class LocalSourceReader{
  constructor({catalog}){this.catalog=catalog;}

  async inspect(request){
    const source=await this.catalog.find(request);
    if(!source)return {availability:'missing',reason:'not-found'};
    if(request.source.kind!=='directory'&&source.ready!==true)return {availability:'unavailable',reason:'not-ready'};
    let directory;
    try{
      directory=await open(source.hostPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      if(!(await directory.stat()).isDirectory())return {availability:'unavailable',reason:'not-directory'};
      return {availability:'available'};
    }catch(error){
      switch(error.code){
        case 'ENOENT':return {availability:'missing',reason:'not-found'};
        case 'ENOTDIR':return {availability:'unavailable',reason:'not-directory'};
        case 'EACCES':case 'EPERM':case 'ELOOP':return {availability:'unavailable',reason:'not-readable'};
        default:throw new ApplicationError('SOURCE_UNAVAILABLE',{cause:error});
      }
    }finally{await directory?.close();}
  }
}
