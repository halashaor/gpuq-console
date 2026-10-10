import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReadSchema} from '../../src/infrastructure/sqlite/read-schema.mjs';
import {createLoginSchema} from '../../src/infrastructure/sqlite/login-schema.mjs';
import {Pbkdf2Passwords} from '../../src/infrastructure/passwords.mjs';
import {assembleSqliteSession} from '../../src/bootstrap/sqlite-session.mjs';
import {assembleLocalSqliteDataRead} from '../../src/bootstrap/sqlite-data-read.mjs';
import {assembleSqliteAccount} from '../../src/bootstrap/sqlite-account.mjs';
import {assembleSqliteComputePolicy} from '../../src/bootstrap/sqlite-compute-policy.mjs';
import {createComputePolicySchema} from '../../src/infrastructure/sqlite/compute-policy-schema.mjs';
import {createDataAccessSchema} from '../../src/infrastructure/sqlite/data-access.mjs';
import {assembleSqliteDataAccess} from '../../src/bootstrap/sqlite-data-access.mjs';
import {assembleSqliteDirectoryRegistration} from '../../src/bootstrap/sqlite-directory-registration.mjs';

export const readRequest = {machineId: 'node-1', source: {kind: 'directory', sourceId: 'images'}};
export const loginRequest = {username: 'alice', password: 'fixture-password'};

export async function sessionFixture({admin = false} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'v2-session-http-'));
  const source = join(directory, 'images');
  await mkdir(source);
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  database.exec('PRAGMA foreign_keys=ON');
  createReadSchema(database);
  createLoginSchema(database);
  createComputePolicySchema(database);
  database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('alice','alice','Alice');
    INSERT INTO v2_machines(id) VALUES('node-1');
    INSERT INTO v2_machine_grants(account_id,machine_id) VALUES('alice','node-1');
    INSERT INTO v2_data_resources VALUES('images','directory','node-1','images',NULL,'shared',NULL)`);
  database.prepare('INSERT INTO v2_source_bindings VALUES(?,?,?,?,?)').run('images', 'node-1', 'directory', source, 1);
  createDataAccessSchema(database);
  if (admin) database.exec("UPDATE v2_accounts SET role='admin' WHERE id='alice'");
  const password = await new Pbkdf2Passwords().hash(loginRequest.password);
  database.prepare('INSERT INTO v2_credentials(account_id,salt,hash,iterations) VALUES(?,?,?,?)')
    .run('alice', password.salt, password.hash, password.iterations);
  const modules = new Map([
    'client/session-client.mjs', 'client/session.mjs', 'client/http-transport.mjs', 'client/errors.mjs',
    'client/data-client.mjs', 'contracts/session.mjs', 'contracts/data-read.mjs', 'contracts/errors.mjs',
    'client/account-client.mjs', 'contracts/account.mjs',
    'client/compute-policy-client.mjs', 'contracts/compute-policy.mjs',
    'client/data-access-client.mjs', 'contracts/data-access.mjs',
    'client/directory-client.mjs', 'contracts/directory-registration.mjs',
  ].map(name => ['/modules/' + name, new URL('../../src/' + name, import.meta.url)]));
  let sessionHandler, dataHandler, accountHandler, computeHandler, accessHandler, registrationHandler, now = Date.now();
  const errors = [], calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push(req.url);
    if (req.url === '/') {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('<!doctype html><title>Session SDK fixture</title>');
    } else if (modules.has(req.url)) {
      res.writeHead(200, {'Content-Type': 'text/javascript'});
      res.end(await readFile(modules.get(req.url)));
    } else if (req.url === '/api/v2/data/register-directory') {
      await registrationHandler(req, res);
    } else if (req.url.startsWith('/api/v2/data-access/')) {
      await accessHandler(req, res);
    } else if (req.url.startsWith('/api/v2/compute-policy/')) {
      await computeHandler(req, res);
    } else if (req.url.startsWith('/api/v2/accounts/')) {
      await accountHandler(req, res);
    } else if (req.url.startsWith('/api/v2/session/')) {
      await sessionHandler(req, res);
    } else {
      await dataHandler(req, res);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const common = {database, publicOrigin: baseUrl, clock: () => now, reportError: error => errors.push(error)};
  sessionHandler = assembleSqliteSession(common);
  accountHandler = assembleSqliteAccount(common);
  computeHandler = assembleSqliteComputePolicy(common);
  accessHandler = assembleSqliteDataAccess(common);
  registrationHandler = assembleSqliteDirectoryRegistration({...common, configuredDirectories: [
    {machineId: 'node-1', sourceId: 'existing', hostPath: source, visibility: 'shared', ownerId: null},
    {machineId: 'node-1', sourceId: 'missing', hostPath: join(directory, 'not-present'), visibility: 'shared', ownerId: null},
    {machineId: 'unlisted', sourceId: 'existing', hostPath: source, visibility: 'shared', ownerId: null},
  ]});
  dataHandler = assembleLocalSqliteDataRead({...common, machineId: 'node-1'});
  return {
    database, baseUrl, errors, calls, advance: ms => now += ms,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      database.close();
      await rm(directory, {recursive: true, force: true});
    },
  };
}
