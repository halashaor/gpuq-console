export class ApiError extends Error{
  constructor(code,{status,cause}={}){super(code,{cause});this.code=code;this.status=status;}
}

/** Browser and Node share this transport. Cookie/token setup belongs to login. */
export class JsonHttpTransport{
  constructor({baseUrl,headers={},fetch=globalThis.fetch}){
    const base=new URL(baseUrl);
    if(base.username||base.password||base.pathname!=='/'||base.search||base.hash
      ||base.protocol!=='https:'&&!(base.protocol==='http:'&&base.hostname==='127.0.0.1'))throw new ApiError('INVALID_API_ORIGIN');
    this.baseUrl=base;this.headers={...headers};this.fetch=fetch;
  }

  async request(path,body,{signal}={}){
    const url=new URL(path,this.baseUrl);
    if(url.origin!==this.baseUrl.origin)throw new ApiError('INVALID_API_ORIGIN');
    let response;
    try{
      const send=this.fetch;
      response=await send(url,{method:'POST',redirect:'error',credentials:'same-origin',signal,
        headers:{...this.headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    }catch(cause){throw new ApiError(signal?.aborted?'REQUEST_ABORTED':'NETWORK_UNAVAILABLE',{cause});}
    let payload;
    try{payload=await response.json();}catch(cause){throw new ApiError('INVALID_API_RESPONSE',{status:response.status,cause});}
    if(!response.ok)throw new ApiError(typeof payload?.error?.code==='string'?payload.error.code:'INVALID_API_RESPONSE',{status:response.status});
    return payload;
  }
}
