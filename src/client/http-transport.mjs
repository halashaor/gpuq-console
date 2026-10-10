import {ApiError} from './errors.mjs';
import {ClientSession} from './session.mjs';
export {ApiError} from './errors.mjs';

/** Browser and Node share this transport. Cookie/token setup belongs to login. */
export class JsonHttpTransport{
  constructor({baseUrl,session=new ClientSession(),fetch=globalThis.fetch}){
    const base=new URL(baseUrl);
    if(base.username||base.password||base.pathname!=='/'||base.search||base.hash
      ||base.protocol!=='https:'&&!(base.protocol==='http:'&&base.hostname==='127.0.0.1'))throw new ApiError('INVALID_API_ORIGIN');
    this.baseUrl=base;this.session=session;this.fetch=fetch;
  }

  async request(path,body,{signal}={}){
    const url=new URL(path,this.baseUrl);
    if(url.origin!==this.baseUrl.origin)throw new ApiError('INVALID_API_ORIGIN');
    const identity=this.session.snapshot();
    const activeSignal=signal?AbortSignal.any([identity.signal,signal]):identity.signal;
    const check=()=>{identity.signal.throwIfAborted();if(signal?.aborted)throw new ApiError('REQUEST_ABORTED');};
    check();
    let response;
    try{
      const send=this.fetch;
      response=await send(url,{method:'POST',redirect:'error',credentials:'same-origin',signal:activeSignal,
        headers:{...identity.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    }catch(cause){check();throw new ApiError('NETWORK_UNAVAILABLE',{cause});}
    check();
    let payload;
    try{payload=await response.json();}catch(cause){check();throw new ApiError('INVALID_API_RESPONSE',{status:response.status,cause});}
    check();
    if(!response.ok)throw new ApiError(typeof payload?.error?.code==='string'?payload.error.code:'INVALID_API_RESPONSE',{status:response.status});
    return payload;
  }
}
