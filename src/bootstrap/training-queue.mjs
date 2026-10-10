import {AdvanceTrainingQueue} from '../application/advance-training-queue.mjs';
import {PrepareTaskDispatch} from '../application/prepare-task-dispatch.mjs';
import {ObserveTaskCandidates} from '../application/observe-task-candidates.mjs';
import {ObserveTrainingResources} from '../application/observe-training-resources.mjs';
import {ValidateTrainingResources} from '../application/validate-training-resources.mjs';
import {GpuqPolicy} from '../infrastructure/gpuq-policy.mjs';
import {SqliteTaskAuthority} from '../infrastructure/sqlite/task-authority.mjs';
import {SqliteTrainingCatalog} from '../infrastructure/sqlite/training-catalog.mjs';
import {SqliteComputeClaims} from '../infrastructure/sqlite/compute-claims.mjs';
import {SqliteTrainingDispatches} from '../infrastructure/sqlite/training-dispatches.mjs';
import {SqliteTrainingQueue} from '../infrastructure/sqlite/training-queue.mjs';

/** Explicit composition only; caller owns schema, lifecycle and trusted node adapters. */
export function assembleTrainingQueue({database, projects, sources, pools, python, clock = Date.now}) {
  const resources = new ObserveTrainingResources({pools,
    validator: new ValidateTrainingResources({policy: new GpuqPolicy({python})})});
  const observer = new ObserveTaskCandidates({projects, sources, resources,
    authority: new SqliteTaskAuthority({database}), catalog: new SqliteTrainingCatalog({database}),
    quota: new SqliteComputeClaims({database})});
  const prepare = new PrepareTaskDispatch({observer, dispatches: new SqliteTrainingDispatches({database}), clock});
  return new AdvanceTrainingQueue({queue: new SqliteTrainingQueue({database}), prepare});
}
