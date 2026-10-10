import {ApplicationError} from '../domain/errors.mjs';

const credentialPattern=/^[a-f0-9]{64}$/;
export function createSessionAuthenticator({authenticateSession,publicOrigin}){
  return async req=>{
    let credential;
    const usingCookie=req.headers.authorization===undefined;
    if(!usingCookie){
      credential=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization)?.[1];
    }else{
      const cookies=(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith('gpuq_session='));
      if(cookies.length===1)credential=cookies[0].slice('gpuq_session='.length);
    }
    if(typeof credential!=='string'||!credentialPattern.test(credential))throw new ApplicationError('UNAUTHENTICATED');
    if(usingCookie&&req.headers.origin!==publicOrigin)throw new ApplicationError('FORBIDDEN');
    return authenticateSession.execute(credential);
  };
}
