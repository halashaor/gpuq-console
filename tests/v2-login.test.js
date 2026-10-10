import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash, pbkdf2Sync} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Login} from '../src/application/login.mjs';
import {SessionLifecycle} from '../src/application/session-lifecycle.mjs';
import {AuthenticateSession} from '../src/application/authenticate-session.mjs';
import {SESSION_POLICY, LOGIN_POLICY} from '../src/domain/session-policy.mjs';
import {Pbkdf2Passwords} from '../src/infrastructure/passwords.mjs';
import {SessionTokens} from '../src/infrastructure/session-tokens.mjs';
import {createReadSchema} from '../src/infrastructure/sqlite/read-schema.mjs';
import {createLoginSchema} from '../src/infrastructure/sqlite/login-schema.mjs';
import {SqliteSessionReader} from '../src/infrastructure/sqlite/session-reader.mjs';
import {SqliteLoginAccounts, SqliteLoginAttempts, SqliteLoginSessions} from '../src/infrastructure/sqlite/login-repositories.mjs';

async function fixture(t, passwords = {verify: async password => password === 'correct'}) {
  const folder = await mkdtemp(join(tmpdir(), 'v2-login-'));
  const path = join(folder, 'state.sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys=ON');
  createReadSchema(database);
  createLoginSchema(database);
  for (const id of ['alice', 'bob', 'carol']) {
    database.prepare('INSERT INTO v2_accounts(id,username,display_name) VALUES(?,?,?)').run(id, id, id);
    database.prepare('INSERT INTO v2_credentials(account_id,salt,hash,iterations) VALUES(?,?,?,?)')
      .run(id, 'test-salt', 'test-hash', 600000);
  }
  let now = 1000;
  const clock = () => now;
  const accounts = new SqliteLoginAccounts({database});
  const attempts = new SqliteLoginAttempts({database});
  const sessions = new SqliteLoginSessions({database});
  const tokens = new SessionTokens();
  const login = new Login({accounts, attempts, sessions, tokens, passwords, clock});
  const lifecycle = new SessionLifecycle({sessions, clock});
  const authenticate = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  t.after(async () => {
    if (database.isOpen) database.close();
    await rm(folder, {recursive: true, force: true});
  });
  return {database, path, clock, now: value => now = value, accounts, attempts, sessions, tokens, login, lifecycle, authenticate};
}
const credentials = username => ({username, password: 'correct'});
const hasCode = code => error => error.code === code;
function deferred() {
  let resolve;
  const promise = new Promise(done => resolve = done);
  return {promise, resolve};
}

test('password adapter verifies current and legacy hashes without accepting missing accounts', async () => {
  const passwords = new Pbkdf2Passwords();
  const record = await passwords.hash('example-password');
  assert.equal(record.iterations, 600000);
  assert.equal(await passwords.verify('example-password', record), true);
  assert.equal(await passwords.verify('wrong', record), false);
  const salt = Buffer.alloc(16, 3);
  const legacy = {salt: salt.toString('base64'), iterations: 210000,
    hash: pbkdf2Sync('legacy-password', salt, 210000, 32, 'sha256').toString('base64')};
  assert.equal(await passwords.verify('legacy-password', legacy), true);
  assert.equal(await passwords.verify('wrong', null), false);
});

test('issued session persists across database reopen and stores only the credential digest', async t => {
  const f = await fixture(t);
  const result = await f.login.execute(credentials('alice'));
  assert.match(result.credential, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.account, {id: 'alice', username: 'alice', displayName: 'alice', role: 'member'});
  assert.equal(result.expiresAtMs, f.clock() + SESSION_POLICY.idleMs);
  const row = f.database.prepare('SELECT * FROM v2_sessions').get();
  assert.equal(row.token_hash, createHash('sha256').update(result.credential).digest('hex'));
  assert.equal(JSON.stringify(row).includes(result.credential), false);
  assert.deepEqual(await f.authenticate.execute(result.credential), result.actor);
  f.database.close();
  const reopened = new DatabaseSync(f.path, {readOnly: true});
  try {
    const authenticate = new AuthenticateSession({sessions: new SqliteSessionReader({database: reopened}), clock: f.clock});
    assert.deepEqual(await authenticate.execute(result.credential), result.actor);
  } finally { reopened.close(); }
});

test('invalid, disabled and missing accounts share one error; failure limit expires and success clears it', async t => {
  const f = await fixture(t);
  f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='bob'");
  for (const request of [credentials('missing'), credentials('bob'), {username: 'alice', password: 'wrong'}]) {
    await assert.rejects(f.login.execute(request), hasCode('INVALID_CREDENTIALS'));
  }
  for (let n = 1; n < LOGIN_POLICY.failures; n++) {
    await assert.rejects(f.login.execute({username: 'alice', password: 'wrong'}), hasCode('INVALID_CREDENTIALS'));
  }
  await assert.rejects(f.login.execute(credentials('alice')), hasCode('LOGIN_RATE_LIMIT'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 0);
  f.now(1000 + LOGIN_POLICY.windowMs);
  await f.login.execute(credentials('alice'));
  assert.equal(f.attempts.find('alice'), null);
});

test('bounded password work rejects duplicate/concurrent attempts and frees slots after failure', async t => {
  const entered = deferred(), release = deferred();
  let count = 0;
  const f = await fixture(t, {verify: async () => {
    if (++count === 2) entered.resolve();
    await release.promise;
    return false;
  }});
  const first = assert.rejects(f.login.execute(credentials('alice')), hasCode('INVALID_CREDENTIALS'));
  const second = assert.rejects(f.login.execute(credentials('bob')), hasCode('INVALID_CREDENTIALS'));
  await entered.promise;
  await assert.rejects(f.login.execute(credentials('alice')), hasCode('LOGIN_BUSY'));
  await assert.rejects(f.login.execute(credentials('carol')), hasCode('LOGIN_BUSY'));
  release.resolve();
  await Promise.all([first, second]);
  await assert.rejects(f.login.execute(credentials('carol')), hasCode('INVALID_CREDENTIALS'));
});

test('credential or account changes during password verification prevent session issuance', async t => {
  for (const change of [
    "UPDATE v2_credentials SET revision=revision+1 WHERE account_id='alice'",
    "UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id='alice'",
    "UPDATE v2_accounts SET enabled=0 WHERE id='alice'",
  ]) {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, {verify: async () => {entered.resolve(); await release.promise; return true;}});
    const pending = f.login.execute(credentials('alice'));
    await entered.promise;
    f.database.exec(change);
    release.resolve();
    await assert.rejects(pending, hasCode('AUTHENTICATION_CHANGED'));
    assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 0);
  }
});

test('issuance rolls back pruning on storage failure and enforces both session caps', async t => {
  const f = await fixture(t);
  const expired = await f.login.execute(credentials('alice'));
  f.now(expired.expiresAtMs);
  f.attempts.recordFailure('alice', f.clock(), LOGIN_POLICY.windowMs);
  f.database.exec("CREATE TRIGGER reject_session BEFORE INSERT ON v2_sessions BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(f.login.execute(credentials('alice')), /injected failure/);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_sessions').get().n, 1);
  assert.equal(f.attempts.find('alice').failures, 1);
  f.database.exec('DROP TRIGGER reject_session');
  await f.login.execute(credentials('alice'));
  const issue = (username, policy) => f.sessions.issue({account: f.accounts.findCredentials(username), token: f.tokens.create(), now: f.clock(), policy});
  assert.equal(issue('alice', {...SESSION_POLICY, perAccount: 1}).kind, 'limit');
  assert.equal(issue('bob', {...SESSION_POLICY, total: 1}).kind, 'limit');
  assert.equal(issue('bob', SESSION_POLICY).kind, 'issued');
});

test('refresh extends idle expiry hourly; logout is scoped, idempotent and does not revive sessions', async t => {
  const f = await fixture(t);
  const first = await f.login.execute(credentials('alice'));
  const second = await f.login.execute(credentials('alice'));
  f.now(1000 + SESSION_POLICY.touchMs - 1);
  assert.equal((await f.lifecycle.refresh(first.actor)).expiresAtMs, first.expiresAtMs);
  assert.equal(f.database.prepare('SELECT touched_at_ms FROM v2_sessions WHERE id=?').get(first.actor.sessionId).touched_at_ms, 1000);
  f.now(1000 + SESSION_POLICY.touchMs);
  assert.equal((await f.lifecycle.refresh(first.actor)).expiresAtMs, f.clock() + SESSION_POLICY.idleMs);
  await f.lifecycle.logout({...first.actor, id: 'bob'});
  assert.deepEqual(await f.authenticate.execute(first.credential), first.actor);
  await f.lifecycle.logout(first.actor);
  await f.lifecycle.logout(first.actor);
  await assert.rejects(f.lifecycle.refresh(first.actor), hasCode('UNAUTHENTICATED'));
  assert.deepEqual(await f.authenticate.execute(second.credential), second.actor);
  for (const sql of [
    "UPDATE v2_accounts SET enabled=0 WHERE id='alice'",
    "UPDATE v2_accounts SET auth_revision=1 WHERE id='alice'",
    `UPDATE v2_sessions SET expires_at_ms=${f.clock()}`,
  ]) {
    f.database.exec(sql);
    await assert.rejects(f.lifecycle.refresh(second.actor), hasCode('UNAUTHENTICATED'));
    f.database.exec("UPDATE v2_accounts SET enabled=1,auth_revision=0 WHERE id='alice'");
  }
});

test('explicit schema step cannot roll back a caller-owned transaction', () => {
  const database = new DatabaseSync(':memory:');
  try {
    createReadSchema(database);
    database.exec("BEGIN; INSERT INTO v2_accounts(id,username,display_name) VALUES('alice','alice','Alice')");
    assert.throws(() => createLoginSchema(database), /transaction/);
    assert.equal(database.prepare('SELECT count(*) n FROM v2_accounts').get().n, 1);
    database.exec('ROLLBACK');
    createLoginSchema(database);
    assert.throws(() => createLoginSchema(database), /already exists/);
    assert.equal(database.prepare('SELECT count(*) n FROM v2_credentials').get().n, 0);
  } finally { database.close(); }
});
