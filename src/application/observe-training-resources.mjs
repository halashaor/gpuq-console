import {trainingResourceFit} from '../domain/training-resource-fit.mjs';
import {ApplicationError} from '../domain/errors.mjs';

/** No reservation: configured limits and observed exclusive free fit only. */
export class ObserveTrainingResources {
  constructor({validator, pools}) {this.validator = validator; this.pools = pools;}
  validate(request) {return this.validator.intent(request);}
  async execute(validated, candidate) {
    const pool = await this.pools.inspect({machineId: candidate.machineId});
    if (pool.machineId !== candidate.machineId) throw new ApplicationError('GPU_POOL_NODE_MISMATCH');
    return {...trainingResourceFit(validated, candidate, pool), pool};
  }
}
