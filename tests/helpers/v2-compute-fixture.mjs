import {randomUUID} from 'node:crypto';
import {sessionFixture, loginRequest} from './v2-session-fixture.mjs';
import {SessionClient} from '../../src/client/session-client.mjs';
import {JsonHttpTransport} from '../../src/client/http-transport.mjs';
import {createTrainingRequestSchema, SqliteTrainingRequests} from '../../src/infrastructure/sqlite/training-requests.mjs';
import {createComputeClaimsSchema, SqliteComputeClaims} from '../../src/infrastructure/sqlite/compute-claims.mjs';

export async function computeFixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  createTrainingRequestSchema(f.database); createComputeClaimsSchema(f.database);
  f.database.exec(`UPDATE v2_machines SET cards=8; UPDATE v2_machine_grants SET max_cards=4;
    INSERT INTO v2_machines(id,cards) VALUES('node-2',8);
    INSERT INTO v2_machine_grants VALUES('alice','node-2',4);
    INSERT INTO v2_compute_policies VALUES('alice',4,0)`);
  await new SessionClient({transport: new JsonHttpTransport({baseUrl: f.baseUrl}), delivery: 'token'}).login(loginRequest);
  const actor = {id: 'alice', sessionId: f.database.prepare('SELECT id FROM v2_sessions').get().id}, now = Date.now();
  const requests = new SqliteTrainingRequests({database: f.database}), claims = new SqliteComputeClaims({database: f.database});
  const job = () => requests.record(actor, {requestId: randomUUID(), name: '训练', description: '', preparedSpec: {}}, now).jobId;
  return {...f, actor, now, job, claims, ready() {f.database.exec('UPDATE v2_compute_accounting SET ready=1');}};
}
