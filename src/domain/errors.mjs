// Domain failures contain stable codes, not HTTP status or UI prose.
export class ApplicationError extends Error{
  constructor(code,options){super(code,options);this.code=code;}
}
