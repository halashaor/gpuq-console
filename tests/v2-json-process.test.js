import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonProcess} from '../src/infrastructure/json-process.mjs';

test('native JSON transport sends structured input without shell interpretation', async () => {
  const input = {value: '$(not-a-command); 中文'};
  const result = await jsonProcess({program: process.execPath, args: ['-e',
    "const fs=require('node:fs');process.stdout.write(JSON.stringify({result:JSON.parse(fs.readFileSync(0,'utf8'))}))"], input});
  assert.deepEqual(result, {result: input});
});

test('invalid bounds and excessive input are rejected before starting a program', async () => {
  const options = {program: '/no/such/program', args: [], input: {value: 'x'.repeat(100)}};
  await assert.rejects(jsonProcess({...options, timeoutMs: 0}), /bounds/);
  await assert.rejects(jsonProcess({...options, maxBytes: 10}), error => error.code === 'NATIVE_REQUEST_TOO_LARGE');
});

test('malformed or oversized native output cannot be treated as a successful response', async () => {
  await assert.rejects(jsonProcess({program: process.execPath, args: ['-e', "process.stdout.write('not-json')"], input: {}}), SyntaxError);
  await assert.rejects(jsonProcess({program: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(10000))"], input: {}, maxBytes: 64}),
    error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
});

test('a stuck native query is terminated by its configured deadline', async () => {
  await assert.rejects(jsonProcess({program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], input: {}, timeoutMs: 50}),
    error => error.killed === true);
});
