import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReadSchema} from '../src/infrastructure/sqlite/read-schema.mjs';
import {SqliteDataAuthority,SqliteSourceCatalog} from '../src/infrastructure/sqlite/data-read-repositories.mjs';
import {SqliteSessionReader} from '../src/infrastructure/sqlite/session-reader.mjs';
import {AuthenticateSession} from '../src/application/authenticate-session.mjs';
import {DataReadAccess} from '../src/application/data-read-access.mjs';
import {ResolveDataRead} from '../src/application/resolve-data-read.mjs';
import {LocalSourceReader} from '../src/infrastructure/local-source-reader.mjs';
import {assembleLocalSqliteDataRead} from '../src/bootstrap/sqlite-data-read.mjs';
import {DATA_READ_ROUTE} from '../src/contracts/data-read.mjs';

const tokens={alice:'a'.repeat(64),bob:'b'.repeat(64),admin:'c'.repeat(64)},version='d'.repeat(64);
const directory={machineId:'node-1',source:{kind:'directory',sourceId:'images'}};
const warehouse={machineId:'node-1',source:{kind:'warehouse',datasetId:'private-images',version}};
const actor=id=>({id,sessionId:'session-'+id});
async function fixture(t){
  const folder=await mkdtemp(join(tmpdir(),'v2-authority-')),path=join(folder,'state.sqlite'),source=join(folder,'source');
  await mkdir(source);await writeFile(join(source,'sample'),'original');
  const database=new DatabaseSync(path);database.exec('PRAGMA foreign_keys=ON');createReadSchema(database);
  for(const id of Object.keys(tokens)){
    database.prepare('INSERT INTO v2_accounts(id,username,display_name,role) VALUES(?,?,?,?)').run(id,id,id,id==='admin'?'admin':'member');
    database.prepare('INSERT INTO v2_sessions(id,token_hash,account_id,auth_revision,expires_at_ms) VALUES(?,?,?,?,?)')
      .run('session-'+id,createHash('sha256').update(tokens[id]).digest('hex'),id,0,5000);
  }
  database.prepare('INSERT INTO v2_machines(id) VALUES(?)').run('node-1');
  for(const id of ['alice','bob'])database.prepare('INSERT INTO v2_machine_grants VALUES(?,?)').run(id,'node-1');
  database.prepare('INSERT INTO v2_data_resources VALUES(?,?,?,?,?,?,?)').run('shared','directory','node-1','images',null,'shared',null);
  database.prepare('INSERT INTO v2_data_resources VALUES(?,?,?,?,?,?,?)').run('private','dataset',null,'private-images',version,'private','alice');
  database.prepare('INSERT INTO v2_source_bindings VALUES(?,?,?,?,?)').run('shared','node-1','directory',source,1);
  database.prepare('INSERT INTO v2_source_bindings VALUES(?,?,?,?,?)').run('private','node-1','warehouse',source,1);
  let now=1000;
  const clock=()=>now,authority=new SqliteDataAuthority({database}),catalog=new SqliteSourceCatalog({database});
  const access=new DataReadAccess({authority,clock}),sessions=new SqliteSessionReader({database});
  const authenticate=new AuthenticateSession({sessions,clock});
  const resolve=new ResolveDataRead({access,sources:new LocalSourceReader({machineId:'node-1',catalog})});
  t.after(async()=>{if(database.isOpen)database.close();await rm(folder,{recursive:true,force:true});});
  return {database,path,source,clock,access,authenticate,resolve,catalog,now:v=>now=v};
}
test('persistent source lookup and independent machine/data permissions work without copying',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.authenticate.execute(tokens.alice),actor('alice'));
  assert.equal((await f.resolve.execute(actor('alice'),warehouse)).availability,'available');
  await assert.rejects(f.resolve.execute(actor('bob'),warehouse),e=>e.code==='FORBIDDEN');
  f.database.prepare('INSERT INTO v2_data_readers VALUES(?,?)').run('private','bob');
  assert.equal((await f.resolve.execute(actor('bob'),warehouse)).availability,'available');
  f.database.prepare('DELETE FROM v2_machine_grants WHERE account_id=?').run('bob');
  await assert.rejects(f.resolve.execute(actor('bob'),warehouse),e=>e.code==='FORBIDDEN');
  const cache={...warehouse,source:{...warehouse.source,kind:'cache'}};
  assert.equal((await f.resolve.execute(actor('alice'),cache)).availability,'missing','cache presence is not a data grant');
  assert.equal((await f.resolve.execute(actor('alice'),directory)).availability,'available');
});
test('administrator machine access does not grant another user private data',async t=>{
  const f=await fixture(t);
  assert.equal((await f.resolve.execute(actor('admin'),directory)).availability,'available');
  await assert.rejects(f.resolve.execute(actor('admin'),warehouse),e=>e.code==='FORBIDDEN');
  f.database.exec('UPDATE v2_machines SET enabled=0');
  await assert.rejects(f.resolve.execute(actor('admin'),directory),e=>e.code==='FORBIDDEN');
});
test('revoked, expired, disabled or authorization-revision-stale sessions cannot authorize reads',async t=>{
  const f=await fixture(t);
  const changes=[
    "UPDATE v2_sessions SET revoked=1 WHERE account_id='alice'",
    "UPDATE v2_accounts SET enabled=0 WHERE id='alice'",
    "UPDATE v2_accounts SET auth_revision=1 WHERE id='alice'",
    "UPDATE v2_sessions SET expires_at_ms=1000 WHERE account_id='alice'",
  ];
  for(const change of changes){
    f.database.exec('SAVEPOINT scenario');f.database.exec(change);
    await assert.rejects(f.authenticate.execute(tokens.alice),e=>e.code==='UNAUTHENTICATED');
    await assert.rejects(f.access.requireRead(actor('alice'),directory),e=>e.code==='UNAUTHENTICATED');
    f.database.exec('ROLLBACK TO scenario; RELEASE scenario');
  }
  await assert.rejects(f.access.requireRead({id:'bob',sessionId:'session-alice'},directory),e=>e.code==='UNAUTHENTICATED');
});
test('source and session revocation during filesystem observation rejects the delayed reply',async t=>{
  const f=await fixture(t);f.database.prepare('INSERT INTO v2_data_readers VALUES(?,?)').run('private','bob');
  for(const [change,code] of [["DELETE FROM v2_data_readers WHERE account_id='bob'",'FORBIDDEN'],["UPDATE v2_sessions SET revoked=1 WHERE account_id='bob'",'UNAUTHENTICATED']]){
    f.database.exec('SAVEPOINT scenario');
    const resolve=new ResolveDataRead({access:f.access,sources:{inspect:async()=>{f.database.exec(change);return {availability:'available'};}}});
    await assert.rejects(resolve.execute(actor('bob'),warehouse),e=>e.code===code);
    f.database.exec('ROLLBACK TO scenario; RELEASE scenario');
  }
});

test('equal directory labels on different machines and different dataset versions never share implicit grants',async t=>{
  const f=await fixture(t);
  f.database.prepare('INSERT INTO v2_machines(id) VALUES(?)').run('node-2');
  f.database.prepare('INSERT INTO v2_machine_grants VALUES(?,?)').run('bob','node-2');
  f.database.prepare('INSERT INTO v2_data_resources VALUES(?,?,?,?,?,?,?)').run('other-directory','directory','node-2','images',null,'private','alice');
  await assert.rejects(f.access.requireRead(actor('bob'),{...directory,machineId:'node-2'}),e=>e.code==='FORBIDDEN');
  await assert.rejects(f.access.requireRead(actor('alice'),{...warehouse,source:{...warehouse.source,version:'e'.repeat(64)}}),e=>e.code==='FORBIDDEN');
  assert.equal(f.catalog.find({...warehouse,machineId:'node-2'}),null,'never borrow another machine storage binding');
  assert.equal((await f.resolve.execute(actor('bob'),directory)).availability,'available');
});

test('schema setup does not roll back a transaction it does not own',async t=>{
  const f=await fixture(t);
  f.database.exec('BEGIN');
  f.database.prepare('INSERT INTO v2_accounts(id,username,display_name) VALUES(?,?,?)').run('pending','pending','pending');
  assert.throws(()=>createReadSchema(f.database));
  assert.ok(f.database.prepare('SELECT id FROM v2_accounts WHERE id=?').get('pending'));
  f.database.exec('ROLLBACK');
  assert.equal(f.database.prepare('SELECT id FROM v2_accounts WHERE id=?').get('pending'),undefined);
  assert.throws(()=>createReadSchema(f.database),'initial schema is not an implicit migration');
  assert.ok(f.database.prepare('SELECT id FROM v2_accounts WHERE id=?').get('alice'));
});
test('a read-only reopened database supplies the same identity, policy and source location',async t=>{
  const f=await fixture(t);f.database.close();
  const database=new DatabaseSync(f.path,{readOnly:true});
  try{
    const sessions=new SqliteSessionReader({database}),access=new DataReadAccess({authority:new SqliteDataAuthority({database}),clock:f.clock});
    assert.deepEqual(await new AuthenticateSession({sessions,clock:f.clock}).execute(tokens.alice),actor('alice'));
    await access.requireRead(actor('alice'),warehouse);
    assert.deepEqual(new SqliteSourceCatalog({database}).find(warehouse),{hostPath:f.source,ready:true});
  }finally{database.close();}
});
test('real HTTP cookie and bearer authentication share SQLite authority; origin and credential ambiguity are rejected',async t=>{
  const f=await fixture(t);let handler;
  const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  handler=assembleLocalSqliteDataRead({database:f.database,machineId:'node-1',publicOrigin:origin,clock:f.clock,reportError:()=>assert.fail('unexpected server error')});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const call=headers=>fetch(origin+DATA_READ_ROUTE,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(directory)});
  const bearer=await call({Authorization:'Bearer '+tokens.alice});assert.equal(bearer.status,200);
  const cookie=await call({Cookie:'gpuq_session='+tokens.alice,Origin:origin});assert.equal(cookie.status,200);assert.deepEqual(await cookie.json(),await bearer.json());
  assert.equal((await call({})).status,401);
  assert.equal((await call({Cookie:'gpuq_session='+tokens.alice,Origin:'https://other.example'})).status,403);
  assert.equal((await call({Authorization:'invalid',Cookie:'gpuq_session='+tokens.alice,Origin:origin})).status,401);
  assert.equal((await call({Cookie:'gpuq_session='+tokens.alice+'; gpuq_session='+tokens.bob,Origin:origin})).status,401);
  f.database.exec("UPDATE v2_sessions SET revoked=1 WHERE account_id='alice'");
  assert.equal((await call({Authorization:'Bearer '+tokens.alice})).status,401);
});

test('a node-local adapter cannot claim another machine path is readable',async()=>{
  let lookups=0;
  const reader=new LocalSourceReader({machineId:'node-1',catalog:{find:async()=>{lookups++;}}});
  await assert.rejects(reader.inspect({...directory,machineId:'node-2'}),e=>e.code==='SOURCE_NODE_MISMATCH');
  assert.equal(lookups,0);
});
