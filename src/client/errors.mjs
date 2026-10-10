export class ApiError extends Error{
  constructor(code,{status,cause}={}){super(code,{cause});this.code=code;this.status=status;}
}
