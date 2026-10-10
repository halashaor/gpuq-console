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

export const readRequest = {machineId: 'node-1', source: {kind: 'directory', sourceId: 'images'}};
export const loginRequest = {username: 'alice', password: 'fixture-password'};

export async function sessionFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'v2-session-http-'));
  const source = join(directory, 'images');
  await mkdir(source);
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  database.exec('PRAGMA foreign_keys=ON');
  createReadSchema(database);
  createLoginSchema(database);
  database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('alice','alice','Alice');
    INSERT INTO v2_machines(id) VALUES('node-1');
    INSERT INTO v2_machine_grants VALUES('alice','node-1');
    INSERT INTO v2_data_resources VALUES('images','directory','node-1','images',NULL,'shared',NULL)`);
  database.prepare('INSERT INTO v2_source_bindings VALUES(?,?,?,?,?)').run('images', 'node-1', 'directory', source, 1);
  const password = await new Pbkdf2Passwords().hash(loginRequest.password);
  database.prepare('INSERT INTO v2_credentials(account_id,salt,hash,iterations) VALUES(?,?,?,?)')
    .run('alice', password.salt, password.hash, password.iterations);
  const modules = new Map([
    'client/session-client.mjs', 'client/session.mjs', 'client/http-transport.mjs', 'client/errors.mjs',
    'client/data-client.mjs', 'contracts/session.mjs', 'contracts/data-read.mjs', 'contracts/errors.mjs',
  ].map(name => ['/modules/' + name, new URL('../../src/' + name, import.meta.url)]));
  let sessionHandler, dataHandler, now = Date.now();
  const errors = [], calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push(req.url);
    if (req.url === '/') {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('<!doctype html><title>Session SDK fixture</title>');
    } else if (modules.has(req.url)) {
      res.writeHead(200, {'Content-Type': 'text/javascript'});
      res.end(await readFile(modules.get(req.url)));
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
