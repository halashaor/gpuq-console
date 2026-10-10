import {randomUUID} from 'node:crypto';

export function trainingSubmission() {
  return {requestId: randomUUID(), name: '训练', description: '',
    project: {id: 'project-1', release: 'a'.repeat(64)}, machines: {kind: 'any'},
    execution: {argv: ['python', 'train.py'], workingDirectory: '.', env: {}},
    resources: {minGpus: 1, maxGpus: 4, elastic: true, autoScaleUp: false, placement: 'any', gpuUuids: [], batch: null, sharing: null},
    scheduling: {priority: 2, mode: 'queue', yieldPolicy: 'never', checkpoint: 'none', restart: 'never'}, dataSources: []};
}
