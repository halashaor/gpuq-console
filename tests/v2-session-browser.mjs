import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {sessionFixture, loginRequest, readRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {DataClient} from '../src/client/data-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';

const fixture = await sessionFixture();
const browser = await chromium.launch({headless: true});
try {
  const transport = new JsonHttpTransport({baseUrl: fixture.baseUrl});
  const nodeSession = new SessionClient({transport, delivery: 'token'});
  const nodeLogin = await nodeSession.login(loginRequest);
  const nodeRead = await new DataClient({transport}).resolveReadLocation(readRequest);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => fixture.errors.push(error));
  await page.goto(fixture.baseUrl);
  const browserLogin = await page.evaluate(async request => {
    const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
    const {SessionClient} = await import('/modules/client/session-client.mjs');
    const {DataClient} = await import('/modules/client/data-client.mjs');
    globalThis.transport = new JsonHttpTransport({baseUrl: location.origin});
    globalThis.sessionClient = new SessionClient({transport, delivery: 'cookie'});
    globalThis.dataClient = new DataClient({transport});
    return sessionClient.login(request);
  }, loginRequest);
  assert.deepEqual(browserLogin, nodeLogin);
  assert.deepEqual(await page.evaluate(request => dataClient.resolveReadLocation(request), readRequest), nodeRead);
  assert.equal(await page.evaluate(() => document.cookie), '');
  const cookies = await context.cookies();
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].sameSite, 'Strict');
  assert.deepEqual(await page.evaluate(() => transport.session.snapshot().headers), {});

  // Recreate the browser context from its persisted cookie jar, without a login.
  const saved = await context.storageState();
  await context.close();
  const restored = await browser.newContext({storageState: saved});
  const reopened = await restored.newPage();
  reopened.on('pageerror', error => fixture.errors.push(error));
  await reopened.goto(fixture.baseUrl);
  const restoredIdentity = await reopened.evaluate(async () => {
    const {JsonHttpTransport} = await import('/modules/client/http-transport.mjs');
    const {SessionClient} = await import('/modules/client/session-client.mjs');
    const {DataClient} = await import('/modules/client/data-client.mjs');
    globalThis.transport = new JsonHttpTransport({baseUrl: location.origin});
    globalThis.sessionClient = new SessionClient({transport, delivery: 'cookie'});
    globalThis.dataClient = new DataClient({transport});
    return sessionClient.restore();
  });
  assert.deepEqual(restoredIdentity, browserLogin);
  assert.deepEqual(await reopened.evaluate(request => dataClient.resolveReadLocation(request), readRequest), nodeRead);
  assert.deepEqual(await reopened.evaluate(() => sessionClient.logout()), {revoked: true});
  assert.deepEqual(await restored.cookies(), []);
  const before = fixture.calls.length;
  assert.equal(await reopened.evaluate(async request => {
    try { await dataClient.resolveReadLocation(request); } catch (error) { return error.code; }
  }, readRequest), 'SESSION_CLOSED');
  assert.equal(fixture.calls.length, before);
  // Browser logout does not revoke the independent CLI session.
  await nodeSession.refresh();
  await nodeSession.logout();
  assert.deepEqual(fixture.errors, []);
  console.log('PASS real browser/Node shared login SDK: SQLite identity, protected read, cookie persistence, HttpOnly, scoped logout and no post-logout requests');
} finally {
  await browser.close();
  await fixture.close();
}
