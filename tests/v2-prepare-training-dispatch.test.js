import test from 'node:test';
import assert from 'node:assert/strict';
import {computeFixture} from './helpers/v2-compute-fixture.mjs';
import {SqliteTrainingRequests} from '../src/infrastructure/sqlite/training-requests.mjs';
import {createTrainingDispatchSchema, SqliteTrainingDispatches} from '../src/infrastructure/sqlite/training-dispatches.mjs';
import {PrepareTrainingDispatch} from '../src/application/prepare-training-dispatch.mjs';

async function fixture(t) {
  const f = await computeFixture(t); f.ready(); createTrainingDispatchSchema(f.database);
  const jobId = f.job(), requests = new SqliteTrainingRequests({database: f.database});
  const dispatches = new SqliteTrainingDispatches({database: f.database});
  const candidates = [
    {machineId: 'node-1', quotaFit: {exclusiveFreeFitGpuCount: 2}},
    {machineId: 'node-2', quotaFit: {exclusiveFreeFitGpuCount: 4}},
  ];
  let calls = 0;
  const observer = {async execute(actor, request) {
    calls++; assert.equal(actor, f.actor);
    assert.deepEqual(request, requests.submission(f.actor, jobId, f.now));
    return {candidates};
  }};
  const app = new PrepareTrainingDispatch({requests, observer, dispatches});
  return {...f, jobId, app, candidates, observer, dispatches, calls: () => calls};
}

test('preparation uses stored intent, selects the largest current fit and recovers without re-observing', async t => {
  const f = await fixture(t), first = await f.app.execute(f.actor, f.jobId);
  assert.equal(first.kind, 'prepared'); assert.equal(first.dispatch.machineId, 'node-2');
  assert.equal(first.dispatch.gpuCount, 4);
  f.candidates.reverse();
  assert.deepEqual(await f.app.execute(f.actor, f.jobId), first);
  assert.equal(f.calls(), 1);
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 4);
});

test('equal fits preserve candidate preference; no fit remains waiting without a quota hold', async t => {
  const f = await fixture(t);
  for (const candidate of f.candidates) candidate.quotaFit.exclusiveFreeFitGpuCount = null;
  assert.deepEqual(await f.app.execute(f.actor, f.jobId), {kind: 'waiting', jobId: f.jobId, reason: 'no-current-exclusive-fit'});
  assert.equal(f.claims.get(f.actor, f.jobId, f.now), null);
  for (const candidate of f.candidates) candidate.quotaFit.exclusiveFreeFitGpuCount = 2;
  assert.equal((await f.app.execute(f.actor, f.jobId)).dispatch.machineId, 'node-1');
});

test('quota consumed after observation returns waiting without automatic alternate dispatch', async t => {
  const f = await fixture(t), original = f.observer.execute;
  f.observer.execute = async (...args) => {
    const result = await original(...args);
    f.claims.claim(f.actor, {jobId: f.job(), machineId: 'node-1', gpuCount: 4}, f.now);
    return result;
  };
  assert.deepEqual(await f.app.execute(f.actor, f.jobId), {kind: 'waiting', jobId: f.jobId, reason: 'quota-changed'});
  assert.equal(f.dispatches.get(f.actor, f.jobId, f.now), null);
});

test('another preparer wins during observation: recover its original target, do not create a second dispatch', async t => {
  const f = await fixture(t), original = f.observer.execute;
  let winner;
  f.observer.execute = async (...args) => {
    const result = await original(...args);
    winner = f.dispatches.prepare(f.actor, {jobId: f.jobId, machineId: 'node-1', gpuCount: 2}, f.now);
    return result;
  };
  assert.deepEqual(await f.app.execute(f.actor, f.jobId), {kind: 'prepared', dispatch: winner});
  assert.equal(f.claims.balance(f.actor, 'node-1', f.now).heldTotal, 2);
});
