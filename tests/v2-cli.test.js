import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';

const script = fileURLToPath(new URL('../scripts/v2-client.mjs', import.meta.url));
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.end(input);
  });
}

test('real CLI processes login, reopen, read and logout without exposing credentials', async t => {
  const f = await sessionFixture(); t.after(() => f.close());
  const directory = await mkdtemp(join(tmpdir(), 'v2-cli-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const args = ['--url', f.baseUrl, '--credentials', join(directory, 'credentials.sqlite')];
  const login = await run([...args, 'login', '--username', loginRequest.username, '--password-stdin'], loginRequest.password + '\n');
  assert.equal(login.code, 0, login.stderr);
  assert.equal(JSON.parse(login.stdout).account.username, 'alice');
  assert.equal(login.stdout.includes(loginRequest.password), false);
  assert.equal(Object.hasOwn(JSON.parse(login.stdout), 'credential'), false);
  const current = await run([...args, 'current']);
  assert.equal(current.code, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).account.username, 'alice');
  const read = await run([...args, 'read', '--machine', 'node-1', '--kind', 'directory', '--source', 'images']);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).location.containerPath, '/datasets/images');
  const logout = await run([...args, 'logout']);
  assert.equal(logout.code, 0, logout.stderr);
  assert.deepEqual(JSON.parse(logout.stdout), {revoked: true});
  const after = await run([...args, 'current']);
  assert.equal(after.code, 1);
  assert.equal(after.stdout, '');
  assert.match(after.stderr, /INVALID_SESSION_CREDENTIAL/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 1);
});

test('V2 CLI is explicitly targeted and help does not need a server or credential file', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /not the installed gpuctl/);
  assert.equal((await run(['current'])).code, 1);
});

test('real CLI accounts command returns the administrator-visible names and paging cursor', async t => {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  const directory = await mkdtemp(join(tmpdir(), 'v2-cli-accounts-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const args = ['--url', f.baseUrl, '--credentials', join(directory, 'credentials.sqlite')];
  const login = await run([...args, 'login', '--username', loginRequest.username, '--password-stdin'], loginRequest.password);
  assert.equal(login.code, 0, login.stderr);
  const response = await run([...args, 'accounts', '--limit', '1']);
  assert.equal(response.code, 0, response.stderr);
  assert.deepEqual(JSON.parse(response.stdout), {accounts: [{id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin', enabled: true, revision: 0}], nextCursor: null});
});
