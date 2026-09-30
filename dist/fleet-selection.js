// Shared candidate/release selection for the API, browser and bundled CLI.
export const fleetCapable=host=>host?.reachable===true&&host.gpuq?.connected===true&&!host.gpuq.observeOnly&&
  Array.isArray(host.gpuq.capabilities)&&['console-fleet-v1','fleet-admission-v2'].every(c=>host.gpuq.capabilities.includes(c));
export function fleetSelection(hosts,targetReleases,available){
  if(!Array.isArray(hosts)||!hosts.length||hosts.length>available.length||hosts.some(h=>typeof h!=='string'||!available.includes(h))||new Set(hosts).size!==hosts.length)throw Error('自动选机请明确选择唯一的候选服务器数组。');
  if(targetReleases!==undefined&&(!targetReleases||typeof targetReleases!=='object'||Array.isArray(targetReleases)||!Object.keys(targetReleases).length||Object.entries(targetReleases).some(([h,r])=>!hosts.includes(h)||typeof r!=='string'||!/^[a-f0-9]{64}$/.test(r))))throw Error('节点版本映射必须属于候选范围并使用完整 release。');
  return {hosts:[...hosts],...(targetReleases?{targetReleases:Object.fromEntries(hosts.filter(h=>Object.hasOwn(targetReleases,h)).map(h=>[h,targetReleases[h]]))}:{})};
}
export function parseTargetReleases(values){
  if(!values.length)return undefined;const result={};
  for(const value of values){const match=/^([^=]+)=([a-f0-9]{64})$/.exec(value);if(!match||Object.hasOwn(result,match[1]))throw Error('节点版本请使用唯一的 SERVER=完整64位hash。');result[match[1]]=match[2];}
  return result;
}
