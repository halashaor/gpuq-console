import {requireDataReadPermission} from '../domain/read-access.mjs';

export class DataReadAccess{
  constructor({authority,clock=Date.now}){this.authority=authority;this.clock=clock;}
  async requireRead(actor,request){
    const facts=await this.authority.snapshot(actor,request);
    requireDataReadPermission(actor,facts,this.clock());
  }
}
