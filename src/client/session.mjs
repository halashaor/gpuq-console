import {ApiError} from './errors.mjs';

/** One client identity lifetime. Login persistence is a separate adapter. */
export class ClientSession{
  #headers;
  #controller;
  #revision=0;
  constructor({headers={}}={}){this.#headers={...headers};this.#controller=new AbortController();}

  snapshot(){return {headers:{...this.#headers},signal:this.#controller.signal,revision:this.#revision};}

  replace({headers={}}={}){
    this.#revision++;
    this.#controller.abort(new ApiError('SESSION_CHANGED'));
    this.#headers={...headers};this.#controller=new AbortController();
  }

  close(){this.#revision++;this.#controller.abort(new ApiError('SESSION_CLOSED'));this.#headers={};}
}
