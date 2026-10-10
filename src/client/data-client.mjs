import {DATA_READ_ROUTE,parseDataReadRequest,parseDataReadResult,InvalidResponse} from '../contracts/data-read.mjs';

export class DataClient{
  constructor({transport}){this.transport=transport;}

  async resolveReadLocation(request,options){
    const input=parseDataReadRequest(request);
    const response=await this.transport.request(DATA_READ_ROUTE,input,options);
    const result=parseDataReadResult(response?.result);
    if(result.machineId!==input.machineId||JSON.stringify(result.source)!==JSON.stringify(input.source))throw new InvalidResponse();
    return result;
  }
}
