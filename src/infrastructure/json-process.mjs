import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);

/** Bounded local JSON IPC; callers choose fixed programs/arguments, never a shell. */
export async function jsonProcess({program, args, input, timeoutMs = 5000, maxBytes = 8192}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Invalid native process bounds');
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body) > maxBytes) throw Object.assign(new Error('Native request too large'), {code: 'NATIVE_REQUEST_TOO_LARGE'});
  const running = run(program, args, {encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxBytes});
  let inputError;
  running.child.stdin.once('error', error => {inputError = error;});
  running.child.stdin.end(body);
  const {stdout} = await running;
  if (inputError) throw inputError;
  return JSON.parse(stdout);
}
