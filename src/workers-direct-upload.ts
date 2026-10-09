import {fetch as stableFetch} from 'undici/index.js';
import { request, uploadArtifactObject } from './client.ts';
import { workerArtifactDirectUpload, type WorkerArtifactUploadRequest } from './workers-artifact.ts';

type UploadPage = {uploadId:string;expiresAt:string;nextCursor:number|null;
  files:Array<{sha256:string;size:number;url:string;headers:Record<string,string>}>};

export async function uploadDirectWorkerArtifact(input:WorkerArtifactUploadRequest,
  apiUrl:string, headers:HeadersInit, timeoutMs=900_000, callerSignal?:AbortSignal) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('Upload timeout must be positive');
  const prepared=workerArtifactDirectUpload(input);
  const controller=new AbortController();
  const cancel=()=>controller.abort(callerSignal?.reason);
  if(callerSignal?.aborted)cancel();else callerSignal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('Worker upload time limit reached; no deployment was started')),timeoutMs);
  const signal=controller.signal;
  const directRequest=<T>(url:string,init:RequestInit,budget:number,retries:number)=>
    request<T>(url,init,budget,retries,'total',stableFetch as unknown as typeof fetch);
  try {
    signal.throwIfAborted();
    let page=await directRequest<UploadPage>(apiUrl,{method:'POST',headers,
      body:JSON.stringify(prepared.input),signal},60_000,0);
    const uploadId=page.uploadId;
    if(typeof uploadId!=='string'||!uploadId)throw new Error('Invalid Worker upload session');
    const sent=new Set<string>();let cursor=0;
    while(true) {
      if(page.uploadId!==uploadId || !Array.isArray(page.files))
        throw new Error('Invalid Worker upload authorization');
      for(const item of page.files) {
        signal.throwIfAborted();
        const bytes=prepared.files.get(item.sha256);
        if(!bytes || bytes.length!==item.size || sent.has(item.sha256))
          throw new Error('Worker upload authorization does not match the artifact');
        const target=new URL(item.url),api=new URL(apiUrl);
        const local=['127.0.0.1','localhost','[::1]'];
        const native=target.protocol==='https:' && target.hostname.endsWith('.r2.cloudflarestorage.com');
        const test=local.includes(api.hostname)&&local.includes(target.hostname)&&target.protocol==='http:';
        if((!native&&!test)||target.username||target.password)
          throw new Error('Invalid temporary Worker object channel');
        const checksum=Buffer.from(item.sha256,'hex').toString('base64');
        if(item.headers?.['x-amz-checksum-sha256']!==checksum)
          throw new Error('Worker upload checksum authorization mismatch');
        await uploadArtifactObject(item.url,new Uint8Array(bytes),{
          'content-type':'application/octet-stream','x-amz-checksum-sha256':checksum,
        },signal);
        sent.add(item.sha256);
      }
      if(page.nextCursor===null)break;
      if(!Number.isSafeInteger(page.nextCursor)||page.nextCursor<=cursor)
        throw new Error('Invalid Worker upload pagination');
      cursor=page.nextCursor;
      page=await directRequest<UploadPage>(apiUrl+'/'+encodeURIComponent(uploadId)+'?cursor='+cursor,
        {headers,signal},30_000,1);
    }
    if(sent.size!==prepared.files.size)throw new Error('Worker upload has missing files');
    signal.throwIfAborted();
    return await directRequest<unknown>(apiUrl+'/'+encodeURIComponent(uploadId)+'/confirm',
      {method:'POST',headers,signal},Math.min(timeoutMs,900_000),0);
  } finally {
    clearTimeout(timer);callerSignal?.removeEventListener('abort',cancel);
  }
}
