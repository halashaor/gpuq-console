// Static build-context coverage. This does not start Docker or build an image.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {matchesGlob} from 'node:path';

const root=new URL('..',import.meta.url);
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
function included(path,rules){
  let keep=true;
  for(const rule of rules){
    if(!rule||rule.startsWith('#'))continue;
    const negated=rule.startsWith('!'),pattern=(negated?rule.slice(1):rule).replace(/^\//,'').replace(/\/$/,'');
    if(matchesGlob(path,pattern)||matchesGlob(path,pattern+'/**'))keep=negated;
  }
  return keep;
}

async function sourceContextErrors(override){
  const dockerfile=await readFile(new URL('../deploy/Dockerfile',import.meta.url),'utf8');
  const rules=(override??await readFile(new URL('../.dockerignore',import.meta.url),'utf8')).split(/\r?\n/).map(line=>line.trim());
  const errors=[],required=new Set();
  for(const line of dockerfile.split(/\r?\n/)){
    if(!/^COPY\s/i.test(line)||/--from=/.test(line))continue; // Artifact from another stage, not source context.
    const tokens=line.trim().split(/\s+/).slice(1).filter(token=>!token.startsWith('--'));
    for(const source of tokens.slice(0,-1)){
      assert.doesNotMatch(source,/\$|["'\[\]]/,'Extend COPY parser when Dockerfile uses variables or JSON form');
      const files=tracked.filter(path=>matchesGlob(path,source)||path.startsWith(source.replace(/\/$/,'')+'/'));
      if(!files.length){errors.push('COPY source does not exist: '+source);continue;}
      for(const path of files){required.add(path);if(!included(path,rules))errors.push('COPY source excluded by .dockerignore: '+path);}
    }
  }
  return {errors,required};
}

test('every source required by actual Docker COPY survives the build context filter',async()=>{
  const {errors,required}=await sourceContextErrors();assert.deepEqual(errors,[]);
  assert.ok(required.has('scripts/build-client.mjs'));assert.ok(required.has('package-lock.json'));
});

test('omitting either new guide reproduces an actual Docker source-context failure',async()=>{
  const ignore=await readFile(new URL('../.dockerignore',import.meta.url),'utf8');
  for(const file of ['docs/SYNC.md','docs/FLEET.md']){
    const modified=ignore.split('\n').filter(line=>line!=='!'+file).join('\n');
    const {errors}=await sourceContextErrors(modified);assert.ok(errors.includes('COPY source excluded by .dockerignore: '+file));
  }
});
