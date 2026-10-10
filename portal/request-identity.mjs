export function sameIdentity(current,admitted){
  return current.userId===admitted.userId&&current.username===admitted.username&&current.role===admitted.role;
}

export function copyRequestArguments(args){
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('参数格式错误。');
  return structuredClone(args);
}
