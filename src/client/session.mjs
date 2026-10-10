import {ApiError} from './errors.mjs';

/** One client identity lifetime. Login persistence is a separate adapter. */
export class ClientSession{
  #headers;
  #controller;
  constructor({headers={}}={}){this.#headers={...headers};this.#controller=new AbortController();}

  snapshot(){return {headers:{...this.#headers},signal:this.#controller.signal};}

  replace({headers={}}={}){
    this.#controller.abort(new ApiError('SESSION_CHANGED'));
    this.#headers={...headers};this.#controller=new AbortController();
  }

  close(){this.#controller.abort(new ApiError('SESSION_CLOSED'));this.#headers={};}
}
