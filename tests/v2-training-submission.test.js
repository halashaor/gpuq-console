import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {sessionFixture} from './helpers/v2-session-fixture.mjs';
import {parseTrainingSubmission} from '../src/contracts/training-submission.mjs';

function request() {
  return {requestId: randomUUID(), name: '训练一', description: '固定全局 batch', project: {id: 'project-1', release: 'a'.repeat(64)},
    machines: {kind: 'any'}, execution: {argv: ['python', 'train.py', '--label', 'two words'], workingDirectory: '.', env: {SEED: '42'}},
    resources: {minGpus: 1, maxGpus: 8, elastic: true, autoScaleUp: true, placement: 'any', gpuUuids: [],
      batch: {globalBatchSize: 64, microBatchSize: 4}, sharing: null},
    scheduling: {priority: 3, mode: 'queue', yieldPolicy: 'save', checkpoint: 'epoch-v1', restart: 'on-preempt'},
    dataSources: [{kind: 'directory', sourceId: 'imagenet'}, {kind: 'warehouse', datasetId: 'labels', version: 'b'.repeat(64)}]};
}
const invalid = error => error.code === 'INVALID_REQUEST';

test('one training wire contract preserves machine selection, exact data references and all priority levels', () => {
  const input = request(), before = structuredClone(input);
  for (let priority = 0; priority <= 4; priority++) {
    const result = parseTrainingSubmission({...input, scheduling: {...input.scheduling, priority}});
    assert.equal(result.scheduling.priority, priority);
    assert.deepEqual(result.dataSources, input.dataSources);
  }
  const selected = parseTrainingSubmission({...input, machines: {kind: 'selected', ids: ['node-2', 'node-1']}});
  assert.deepEqual(selected.machines.ids, ['node-2', 'node-1']);
  assert.deepEqual(input, before);
});

test('explicit pinned sharing and optional HAMi budgets remain selectable without adding consent fields', () => {
  const input = request();
  input.resources = {minGpus: 1, maxGpus: 1, elastic: false, autoScaleUp: false, placement: 'pinned', gpuUuids: ['GPU-abc'], batch: null,
    sharing: {vramMiB: 4096, hami: {smPercent: 30}}};
  input.scheduling = {priority: 1, mode: 'queue', yieldPolicy: 'never', checkpoint: 'none', restart: 'never'};
  assert.deepEqual(parseTrainingSubmission(input).resources, input.resources);
  input.resources.sharing.hami = null;
  assert.equal(parseTrainingSubmission(input).resources.sharing.hami, null);
});

test('caller identity, host binding and prepared payload injection are rejected', () => {
  const input = request();
  for (const injected of [{...input, owner: 'admin'}, {...input, preparedSpec: {}},
    {...input, project: {...input.project, hostPath: '/data/project'}},
    {...input, resources: {...input.resources, assignedGpuUuids: ['GPU-other']}},
    {...input, dataSources: [{kind: 'directory', sourceId: 'data', hostPath: '/data/other'}]}]) {
    assert.throws(() => parseTrainingSubmission(injected), invalid);
  }
});

test('container working directory is relative and scheduler environment cannot be overridden', () => {
  const input = request();
  assert.equal(parseTrainingSubmission({...input, execution: {...input.execution, workingDirectory: './src'}}).execution.workingDirectory, 'src');
  for (const workingDirectory of ['/host/path', '../other', 'src/../../other', 'C:\\host']) {
    assert.throws(() => parseTrainingSubmission({...input, execution: {...input.execution, workingDirectory}}), invalid);
  }
  for (const key of ['CUDA_VISIBLE_DEVICES', 'NVIDIA_VISIBLE_DEVICES', 'GPUQ_JOB_ID']) {
    assert.throws(() => parseTrainingSubmission({...input, execution: {...input.execution, env: {[key]: 'forged'}}}), invalid);
  }
  assert.deepEqual(parseTrainingSubmission(input).execution.argv, input.execution.argv, 'no hidden shell splitting');
});

test('parsed objects are detached and invalid references/counts cannot enter admission', () => {
  const input = request(), result = parseTrainingSubmission(input);
  input.execution.argv[0] = 'changed'; input.execution.env.SEED = '0'; input.resources.batch.globalBatchSize = 999;
  assert.equal(result.execution.argv[0], 'python'); assert.equal(result.execution.env.SEED, '42'); assert.equal(result.resources.batch.globalBatchSize, 64);
  const valid = request();
  for (const bad of [{...valid, project: {...valid.project, release: 'latest'}}, {...valid, machines: {kind: 'selected', ids: ['node-1', 'node-1']}},
    {...valid, resources: {...valid.resources, minGpus: true}}, {...valid, scheduling: {...valid.scheduling, priority: 5}}]) {
    assert.throws(() => parseTrainingSubmission(bad), invalid);
  }
});

test('real browser and Node parse the exact same submission document', async t => {
  const f = await sessionFixture(); t.after(() => f.close());
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage(); await page.goto(f.baseUrl);
    const input = request();
    const result = await page.evaluate(async value => {
      const {parseTrainingSubmission} = await import('/modules/contracts/training-submission.mjs');
      return parseTrainingSubmission(value);
    }, input);
    assert.deepEqual(result, parseTrainingSubmission(input));
  } finally {await browser.close();}
});
