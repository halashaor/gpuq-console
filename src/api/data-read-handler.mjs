import {DATA_READ_ROUTE,parseDataReadRequest,InvalidRequest} from '../contracts/data-read.mjs';
import {ApplicationError} from '../domain/errors.mjs';

const statusByCode={UNAUTHENTICATED:401,FORBIDDEN:403,SOURCE_UNAVAILABLE:503,SOURCE_NODE_MISMATCH:503};
const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};

async function readJson(req){
  let size=0;const chunks=[];
  for await(const part of req.iterator({destroyOnReturn:false})){
    size+=part.length;
    if(size>8192){req.resume();throw new InvalidRequest('body');}
    chunks.push(part);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InvalidRequest('body');}
}

/** Authentication supplies the actor; clients cannot choose an actor in JSON. */
export function createDataReadHandler({authenticate,resolveDataRead,reportError=console.error}){
  return async(req,res)=>{
    if(req.url!==DATA_READ_ROUTE)return reply(res,404,{error:{code:'NOT_FOUND'}});
    if(req.method!=='POST')return reply(res,405,{error:{code:'METHOD_NOT_ALLOWED'}});
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return reply(res,415,{error:{code:'JSON_REQUIRED'}});
    try{
      const actor=await authenticate(req);
      const request=parseDataReadRequest(await readJson(req));
      const result=await resolveDataRead.execute(actor,request);
      reply(res,200,{result});
    }catch(error){
      if(error instanceof InvalidRequest)return reply(res,400,{error:{code:'INVALID_REQUEST',field:error.field}});
      const status=error instanceof ApplicationError?statusByCode[error.code]:undefined;
      if(!status||status>=500)reportError(error);
      reply(res,status||500,{error:{code:status?error.code:'INTERNAL_ERROR'}});
    }
  };
}
