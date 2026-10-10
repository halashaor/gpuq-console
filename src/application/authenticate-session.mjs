import {requireActiveSession} from '../domain/read-access.mjs';

export class AuthenticateSession{
  constructor({sessions,clock=Date.now}){this.sessions=sessions;this.clock=clock;}
  async execute(credential){
    const session=await this.sessions.findByCredential(credential);
    requireActiveSession(session,this.clock());
    return {id:session.accountId,sessionId:session.sessionId};
  }
}
