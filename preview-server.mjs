import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {standaloneClientStream,standaloneClientInfo} from './client-bundle.mjs';

export const PREVIEW_PREFIX='/__preview__';
// No database, executor socket, scheduler, notification worker or node keys.
// The existing Portal remains the sole authenticated state owner.
export function createPreviewServer({upstream,publicOrigin,users,root=resolve('.'),revision='development'}){
  const target=new URL(upstream),origin=new URL(publicOrigin);
  if(target.protocol!=='http:'||target.pathname!=='/'||target.search||target.hash||target.username||target.password)throw Error('A fixed internal HTTP upstream is required');
  if(origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)throw Error('A fixed public origin is required');
  if(!Array.isArray(users)||!users.length||users.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)))throw Error('Explicit preview user IDs are required');
  const allowed=new Set(users);
  function exchange(path,{method='GET',headers={},body}={}){
    return new Promise((yes,no)=>{
      const req=http.request(new URL(path,target),{method,headers:{...headers,host:origin.host}},yes);
      req.setTimeout(30000,()=>req.destroy(Error('Upstream timeout')));req.on('error',no);
      req.end(body);
    });
  }
  async function bytes(response,limit){
    const parts=[];let size=0;
    for await(const part of response){size+=part.length;if(size>limit){response.destroy();throw Error('Response exceeds bound');}parts.push(part);}
    return Buffer.concat(parts);
  }
  const server=http.createServer(async(req,res)=>{
    const json=(status,data)=>{if(res.headersSent)return res.destroy();res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&url.pathname==='/healthz')return json(200,{ok:true,mode:'preview-facade',revision,stateOwner:'stable'});
      if(!url.pathname.startsWith(PREVIEW_PREFIX+'/'))return json(404,{error:'Preview path required'});
      const path=url.pathname.slice(PREVIEW_PREFIX.length);
      if(req.method==='GET'&&path==='/gpuctl.mjs'){
        const stream=standaloneClientStream(origin.origin,{file:resolve(root,'build/gpuctl.mjs')});
        res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});
        stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
      }
      if(req.method==='GET'&&path==='/install.sh'){
        const info=await standaloneClientInfo(origin.origin,{file:resolve(root,'build/gpuctl.mjs')});
        const template=await readFile(resolve(root,'deploy/install-preview.sh'),'utf8');
        res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});
        res.end(template.replaceAll('__PREVIEW_ORIGIN__',origin.origin).replaceAll('__PREVIEW_SHA256__',info.sha256));return;
      }
      const credentials={...(req.headers.authorization?{authorization:req.headers.authorization}:{}),...(req.headers.cookie?{cookie:req.headers.cookie}:{}),origin:origin.origin};
      if(!credentials.authorization&&!credentials.cookie)return json(401,{error:'请先在稳定版登录，再进入灰度入口。'});
      // Check the live identity on every request: revocation has no local TTL.
      const identityResponse=await exchange('/api/call',{method:'POST',headers:{...credentials,'content-type':'application/json'},body:JSON.stringify({operation:'state',args:{view:'summary'}})});
      const identityBytes=await bytes(identityResponse,4*1024*1024);
      if(identityResponse.statusCode!==200)return json(identityResponse.statusCode===401?401:503,{error:'灰度身份未确认，未执行操作。'});
      const identity=JSON.parse(identityBytes);
      if(!allowed.has(identity.principal?.userId))return json(403,{error:'此账号未加入灰度测试。'});
      if(req.destroyed)return;
      if(path==='/api/call'){
        if(req.method!=='POST')return json(405,{error:'POST required'});
        if(!req.headers.authorization&&req.headers.origin!==origin.origin)return json(403,{error:'Browser origin required'});
        if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'JSON required'});
        const body=await bytes(req,1500000);
        // Forward exactly once. A lost write acknowledgement is never retried.
        const response=await exchange(path,{method:'POST',headers:{...credentials,'content-type':'application/json'},body});
        res.writeHead(response.statusCode,{...response.headers,'cache-control':'no-store','x-stargate-channel':'preview'});
        response.on('error',()=>res.destroy());res.on('close',()=>response.destroy());response.pipe(res);return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return json(405,{error:'Read-only asset route'});
      if(path.startsWith('/api/'))return json(404,{error:'Use stable login and account endpoints'});
      if(path==='/preview.css'){
        const payload=await readFile(resolve(root,'dist/preview.css'));
        res.writeHead(200,{'Content-Type':'text/css','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:payload);return;
      }
      const response=await exchange(path+url.search,{headers:credentials});
      if(response.statusCode!==200){response.resume();return json(response.statusCode,{error:'Asset unavailable'});}
      let payload=await bytes(response,64*1024*1024);
      const type=response.headers['content-type']||'application/octet-stream';
      if(path!=='/machines.js'&&/^\/[A-Za-z0-9_./-]+\.(?:js|css|svg|woff2|png|ico)$/.test(path)){
        const candidate=resolve(root,'dist','.'+path),base=resolve(root,'dist')+sep;
        if(!candidate.startsWith(base))return json(400,{error:'Invalid asset path'});
        try{payload=await readFile(candidate);}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      if(type.startsWith('text/html')){
        payload=Buffer.from(payload.toString().replace(/\b(src|href)="\/(?!\/)/g,`$1="${PREVIEW_PREFIX}/`)
          .replace('<body', '<body data-stargate-channel="preview"')
          .replace('</head>',`<link rel="stylesheet" href="${PREVIEW_PREFIX}/preview.css"></head>`)
          .replace(/(<body[^>]*>)/,'$1<aside class="preview-banner" role="status">灰度版 · 真实资源 · <a href="/">返回稳定版</a></aside>'));
      }
      const headers={...response.headers,'cache-control':'no-store','content-length':payload.length,'x-stargate-channel':'preview'};
      delete headers['transfer-encoding'];delete headers['content-encoding'];delete headers.etag;
      res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:payload);
    }catch{json(503,{error:'灰度请求结果未确认；请查询原任务，不要重复提交。'});}
  });
  server.headersTimeout=10000;server.requestTimeout=45000;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createPreviewServer({upstream:process.env.PREVIEW_UPSTREAM,publicOrigin:process.env.PUBLIC_ORIGIN,
    users:JSON.parse(process.env.PREVIEW_USERS||'[]'),revision:process.env.PREVIEW_REVISION,root:process.cwd()});
  server.listen(Number(process.env.PORT||8080),process.env.LISTEN_HOST||'127.0.0.1');
}
