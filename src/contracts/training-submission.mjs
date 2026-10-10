import {InvalidRequest} from './errors.mjs';
import {parseDataSource} from './data-read.mjs';

function fields(value, names, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length
    || names.some(key => !Object.hasOwn(value, key))) throw new InvalidRequest(field);
}
function choice(value, options, field) {
  if (!options.includes(value)) throw new InvalidRequest(field);
  return value;
}
function integer(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new InvalidRequest(field);
  return value;
}
function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new InvalidRequest(field);
  return value;
}
function text(value, field) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw new InvalidRequest(field);
  return value;
}

function machines(value) {
  if (value?.kind === 'any') {fields(value, ['kind'], 'machines'); return {kind: 'any'};}
  fields(value, ['kind', 'ids'], 'machines');
  choice(value.kind, ['selected'], 'machines.kind');
  if (!Array.isArray(value.ids) || !value.ids.length || value.ids.length > 100) throw new InvalidRequest('machines.ids');
  const ids = value.ids.map(id => identifier(id, 'machines.ids'));
  if (new Set(ids).size !== ids.length) throw new InvalidRequest('machines.ids');
  return {kind: 'selected', ids};
}

function execution(value) {
  fields(value, ['argv', 'workingDirectory', 'env'], 'execution');
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 4096) throw new InvalidRequest('execution.argv');
  const argv = value.argv.map(arg => text(arg, 'execution.argv'));
  if (!argv[0]) throw new InvalidRequest('execution.argv');
  const cwd = text(value.workingDirectory, 'execution.workingDirectory');
  if (!cwd || cwd.length > 1024 || cwd.startsWith('/') || cwd.includes('\\')
    || cwd.split('/').some(part => !part || part === '..')) throw new InvalidRequest('execution.workingDirectory');
  const workingDirectory = cwd.split('/').filter(part => part !== '.').join('/') || '.';
  if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) throw new InvalidRequest('execution.env');
  const env = Object.fromEntries(Object.entries(value.env).map(([key, val]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || key.startsWith('GPUQ_')
      || ['CUDA_VISIBLE_DEVICES', 'NVIDIA_VISIBLE_DEVICES'].includes(key)) throw new InvalidRequest('execution.env');
    return [key, text(val, 'execution.env')];
  }));
  return {argv, workingDirectory, env};
}

function resources(value) {
  fields(value, ['minGpus', 'maxGpus', 'elastic', 'autoScaleUp', 'placement', 'gpuUuids', 'batch', 'sharing'], 'resources');
  const minGpus = integer(value.minGpus, 1, 4096, 'resources.minGpus');
  const maxGpus = integer(value.maxGpus, 1, 4096, 'resources.maxGpus');
  if (typeof value.elastic !== 'boolean' || typeof value.autoScaleUp !== 'boolean') throw new InvalidRequest('resources.elastic');
  const placement = choice(value.placement, ['any', 'pinned'], 'resources.placement');
  if (!Array.isArray(value.gpuUuids) || value.gpuUuids.length > 4096
    || value.gpuUuids.some(id => typeof id !== 'string' || !/^GPU-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(id))
    || new Set(value.gpuUuids).size !== value.gpuUuids.length) throw new InvalidRequest('resources.gpuUuids');
  let batch = null, sharing = null;
  if (value.batch !== null) {
    fields(value.batch, ['globalBatchSize', 'microBatchSize'], 'resources.batch');
    batch = {globalBatchSize: integer(value.batch.globalBatchSize, 1, Number.MAX_SAFE_INTEGER, 'resources.batch.globalBatchSize'),
      microBatchSize: integer(value.batch.microBatchSize, 1, Number.MAX_SAFE_INTEGER, 'resources.batch.microBatchSize')};
  }
  if (value.sharing !== null) {
    fields(value.sharing, ['vramMiB', 'hami'], 'resources.sharing');
    let hami = null;
    if (value.sharing.hami !== null) {
      fields(value.sharing.hami, ['smPercent'], 'resources.sharing.hami');
      hami = {smPercent: integer(value.sharing.hami.smPercent, 1, 100, 'resources.sharing.hami.smPercent')};
    }
    sharing = {vramMiB: integer(value.sharing.vramMiB, 1, 2 ** 31 - 1, 'resources.sharing.vramMiB'), hami};
  }
  return {minGpus, maxGpus, elastic: value.elastic, autoScaleUp: value.autoScaleUp, placement, gpuUuids: [...value.gpuUuids], batch, sharing};
}

/** Wire shape only. Permissions, release availability and GPUQ combinations are server admission. */
export function parseTrainingSubmission(value) {
  fields(value, ['requestId', 'name', 'description', 'project', 'machines', 'execution', 'resources', 'scheduling', 'dataSources'], 'request');
  if (typeof value.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId)) throw new InvalidRequest('requestId');
  fields(value.project, ['id', 'release'], 'project');
  if (typeof value.project.release !== 'string' || !/^[a-f0-9]{64}$/.test(value.project.release)) throw new InvalidRequest('project.release');
  fields(value.scheduling, ['priority', 'mode', 'yieldPolicy', 'checkpoint', 'restart'], 'scheduling');
  const scheduling = {
    priority: integer(value.scheduling.priority, 0, 4, 'scheduling.priority'),
    mode: choice(value.scheduling.mode, ['queue', 'preempt-save', 'preempt-now'], 'scheduling.mode'),
    yieldPolicy: choice(value.scheduling.yieldPolicy, ['never', 'now', 'save'], 'scheduling.yieldPolicy'),
    checkpoint: choice(value.scheduling.checkpoint, ['none', 'epoch-v1'], 'scheduling.checkpoint'),
    restart: choice(value.scheduling.restart, ['never', 'on-preempt'], 'scheduling.restart'),
  };
  if (!Array.isArray(value.dataSources) || value.dataSources.length > 100) throw new InvalidRequest('dataSources');
  const result = {requestId: value.requestId, name: text(value.name, 'name'), description: text(value.description, 'description'),
    project: {id: identifier(value.project.id, 'project.id'), release: value.project.release}, machines: machines(value.machines),
    execution: execution(value.execution), resources: resources(value.resources), scheduling, dataSources: value.dataSources.map(parseDataSource)};
  if (new TextEncoder().encode(JSON.stringify(result)).length > 65536) throw new InvalidRequest('request');
  return result;
}
