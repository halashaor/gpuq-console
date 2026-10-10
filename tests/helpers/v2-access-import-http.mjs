import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {sessionFixture, loginRequest} from './v2-session-fixture.mjs';
import {publishedFixture} from './v2-published-fixture.mjs';
import {createManagedRegistrationSchema} from '../../src/infrastructure/sqlite/managed-registrations.mjs';
import {createDataAccessImportSchema} from '../../src/infrastructure/sqlite/data-access-imports.mjs';
import {assembleSqliteDataAccessImport} from '../../src/bootstrap/sqlite-data-access-import.mjs';
import {assembleSqliteSession} from '../../src/bootstrap/sqlite-session.mjs';
import {JsonHttpTransport} from '../../src/client/http-transport.mjs';
import {SessionClient} from '../../src/client/session-client.mjs';
import {DataAccessImportClient} from '../../src/client/data-access-import-client.mjs';

export async function importHttpFixture(t, {mapped = true} = {}) {
  const f = await sessionFixture({admin: true}); t.after(() => f.close());
  const publication = await publishedFixture(t, {owners: ['alice', 'old-bob']});
  createManagedRegistrationSchema(f.database); createDataAccessImportSchema(f.database);
  f.database.exec(`INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  f.database.prepare("INSERT INTO v2_data_resources(id,kind,source_id,version,visibility,owner_id) VALUES('published','dataset','images',?,'private','alice')").run(publication.version);
  for (const kind of ['cache', 'warehouse']) f.database.prepare('INSERT INTO v2_managed_bindings VALUES(?,?,?)').run('published', 'node-1', kind);
  const accountMapping = [{legacyId: 'alice', accountId: 'alice'}, ...(mapped ? [{legacyId: 'old-bob', accountId: 'bob'}] : [])];
  let inspections = 0, importHandler, sessionHandler;
  const calls = [];
  const legacyAccess = {exportAccess(request) {inspections++; return publication.managed.exportAccess(request, {actor: {id: 'alice'}});}};
  const modules = new Map(['client/data-access-import-client.mjs', 'client/http-transport.mjs', 'client/session.mjs', 'client/errors.mjs',
    'contracts/data-access-import.mjs', 'contracts/managed-registration.mjs', 'contracts/data-read.mjs', 'contracts/errors.mjs']
    .map(name => ['/modules/' + name, new URL('../../src/' + name, import.meta.url)]));
  const server = http.createServer(async (req, res) => {
    calls.push(req.url);
    if (req.url === '/') {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>ACL import fixture</title>');}
    else if (modules.has(req.url)) {res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end(await readFile(modules.get(req.url)));}
    else if (req.url.startsWith('/api/v2/data-access-import/')) await importHandler(req, res);
    else await sessionHandler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const common = {database: f.database, publicOrigin: origin, reportError() {}};
  importHandler = assembleSqliteDataAccessImport({...common, legacyAccess, accountMapping});
  sessionHandler = assembleSqliteSession(common);
  const transport = new JsonHttpTransport({baseUrl: origin});
  await new SessionClient({transport, delivery: 'token'}).login(loginRequest);
  return {...publication, database: f.database, origin, transport, calls, legacyAccess, inspections: () => inspections,
    client: new DataAccessImportClient({transport})};
}
