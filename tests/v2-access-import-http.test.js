import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {importHttpFixture} from './helpers/v2-access-import-http.mjs';
import {loginRequest} from './helpers/v2-session-fixture.mjs';
import {DataAccessImportClient} from '../src/client/data-access-import-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DATA_ACCESS_IMPORT_ROUTES, parseImportApplyRequest, parseImportPlanResult, parseImportReceiptResult} from '../src/contracts/data-access-import.mjs';

const hasCode = code => error => error.code === code;
const command = plan => ({requestId: randomUUID(), resourceId: plan.resourceId, planId: plan.planId});
function cli(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/v2-client.mjs', import.meta.url)), ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr})); child.stdin.end(input);
  });
}

test('HTTP import accepts only a server plan and returns an original-ID receipt', async t => {
  const f = await importHttpFixture(t);
  const plan = await f.client.plan({resourceId: 'published'});
  assert.equal(plan.state, 'proposed'); assert.deepEqual(plan.readers, ['bob']);
  const input = command(plan);
  assert.equal(await f.client.receipt({requestId: input.requestId}), null);
  const result = await f.client.apply(input);
  assert.deepEqual(await f.client.receipt({requestId: input.requestId}), result);
  assert.equal(result.state, 'imported'); assert.equal(result.aclRevision, 1);
  await assert.rejects(f.client.apply({...input, requestId: randomUUID()}), hasCode('IMPORT_PLAN_CHANGED'));
});

test('blocked mappings are visible as a review result, not a usable confirmation plan', async t => {
  const f = await importHttpFixture(t, {mapped: false});
  assert.deepEqual(await f.client.plan({resourceId: 'published'}), {state: 'blocked', resourceId: 'published', reason: 'ACCOUNT_MAPPING_REQUIRED', accounts: ['old-bob']});
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_access_imports').get().n, 0);
});

test('member and injected reader/mapping requests cannot trigger legacy queries or writes', async t => {
  const f = await importHttpFixture(t);
  const member = new JsonHttpTransport({baseUrl: f.origin});
  await new SessionClient({transport: member, delivery: 'token'}).login({...loginRequest, username: 'bob'});
  await assert.rejects(new DataAccessImportClient({transport: member}).plan({resourceId: 'published'}), hasCode('FORBIDDEN'));
  await assert.rejects(new DataAccessImportClient({transport: member}).receipt({requestId: randomUUID()}), hasCode('FORBIDDEN'));
  const response = await fetch(f.origin + DATA_ACCESS_IMPORT_ROUTES.apply, {method: 'POST', headers: {
    ...f.transport.session.snapshot().headers, 'Content-Type': 'application/json',
  }, body: JSON.stringify({requestId: randomUUID(), resourceId: 'published', planId: 'a'.repeat(64), readers: ['bob']})});
  assert.equal(response.status, 400); assert.equal(f.inspections(), 0);
  assert.throws(() => parseImportApplyRequest({resourceId: 'published', requestId: randomUUID(), planId: 'a'.repeat(64), accountMapping: []}), hasCode('INVALID_REQUEST'));
});

test('lost apply reply is recovered by receipt lookup without a second submission', async t => {
  const f = await importHttpFixture(t), plan = await f.client.plan({resourceId: 'published'}), input = command(plan);
  const transport = new JsonHttpTransport({baseUrl: f.origin, session: f.transport.session, fetch: async (url, options) => {
    await fetch(url, options); throw new Error('lost response');
  }});
  await assert.rejects(new DataAccessImportClient({transport}).apply(input), hasCode('NETWORK_UNAVAILABLE'));
  assert.equal((await f.client.receipt({requestId: input.requestId})).aclRevision, 1);
  assert.equal(f.calls.filter(path => path === DATA_ACCESS_IMPORT_ROUTES.apply).length, 1);
});

test('no observed receipt while native inspection is in flight is not a failed import', async t => {
  const f = await importHttpFixture(t), plan = await f.client.plan({resourceId: 'published'}), input = command(plan);
  let arrived, release;
  const entered = new Promise(resolve => arrived = resolve), held = new Promise(resolve => release = resolve);
  const original = f.legacyAccess.exportAccess;
  f.legacyAccess.exportAccess = async request => {const result = await original(request); arrived(); await held; return result;};
  const pending = f.client.apply(input);
  await entered;
  assert.equal(await f.client.receipt({requestId: input.requestId}), null);
  release();
  assert.equal((await pending).state, 'imported');
});

test('real browser and Node SDK share plans and import receipts', async t => {
  const f = await importHttpFixture(t), browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    await context.addCookies([{name: 'gpuq_session', value: f.transport.session.snapshot().headers.Authorization.slice(7), url: f.origin, httpOnly: true, sameSite: 'Strict'}]);
    const page = await context.newPage(); await page.goto(f.origin);
    const plan = await page.evaluate(async () => {
      const {DataAccessImportClient} = await import('/modules/client/data-access-import-client.mjs');
      const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
      globalThis.imports = new DataAccessImportClient({transport: new JsonHttpTransport({baseUrl: location.origin})});
      return imports.plan({resourceId: 'published'});
    });
    assert.deepEqual(plan, await f.client.plan({resourceId: 'published'}));
    const input = command(plan), result = await f.client.apply(input);
    assert.deepEqual(await page.evaluate(requestId => imports.receipt({requestId}), input.requestId), result);
  } finally {await browser.close();}
});

test('real CLI processes explicitly plan, confirm and recover an import', async t => {
  const f = await importHttpFixture(t), args = ['--url', f.origin, '--credentials', join(f.directory, 'cli.sqlite')];
  const login = await cli([...args, 'login', '--username', 'alice', '--password-stdin'], loginRequest.password);
  assert.equal(login.code, 0, login.stderr);
  const planned = await cli([...args, 'access-import-plan', '--resource', 'published']);
  assert.equal(planned.code, 0, planned.stderr);
  const input = command(JSON.parse(planned.stdout));
  const applied = await cli([...args, 'access-import', '--resource', input.resourceId, '--plan', input.planId, '--request', input.requestId]);
  assert.equal(applied.code, 0, applied.stderr);
  const receipt = await cli([...args, 'access-import-status', '--request', input.requestId]);
  assert.equal(receipt.code, 0, receipt.stderr);
  assert.deepEqual(JSON.parse(receipt.stdout), JSON.parse(applied.stdout));
});

test('receipt and plan decoders cannot mistake null or an unrelated successful reply for confirmation', () => {
  assert.equal(parseImportReceiptResult(null), null);
  assert.throws(() => parseImportReceiptResult({state: 'imported'}), hasCode('INVALID_API_RESPONSE'));
  assert.throws(() => parseImportPlanResult({state: 'proposed', planId: 'a'.repeat(64)}), hasCode('INVALID_API_RESPONSE'));
});
