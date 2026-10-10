import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const dependencies={contracts:[],domain:[],application:['application','domain'],
  infrastructure:['infrastructure','application','domain'],api:['api','contracts','application','domain'],
  client:['client','contracts'],bootstrap:['bootstrap','api','application','infrastructure','domain']};
async function files(directory){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=resolve(directory,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.name.endsWith('.mjs'))result.push(path);
}return result;}
test('V2 dependency direction excludes legacy service imports and platform I/O from domain/client contracts',async()=>{
  const sourceFiles=await files(root);assert.ok(sourceFiles.length>0);
  for(const path of sourceFiles){
    const name=relative(root,path),layer=name.split('/')[0],source=await readFile(path,'utf8');
    assert.ok(Object.hasOwn(dependencies,layer),name);
    for(const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)){
      const specifier=match[1];
      if(specifier.startsWith('node:')){assert.ok(['infrastructure','api','bootstrap'].includes(layer),`${name} imports platform I/O`);continue;}
      assert.ok(specifier.startsWith('.'),`${name}: external dependency needs an explicit layer decision`);
      const target=relative(root,resolve(dirname(path),specifier));assert.ok(!target.startsWith('..'),`${name} imports legacy code: ${specifier}`);
      assert.ok(dependencies[layer].includes(target.split('/')[0]),`${name} crosses its layer: ${specifier}`);
    }
  }
});
