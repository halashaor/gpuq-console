import {timingSafeEqual} from 'node:crypto';
import {SOURCE_INSPECTION_ROUTE} from '../contracts/source-inspection.mjs';
import {parseDataReadRequest} from '../contracts/data-read.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {readObservation} from '../domain/data-source.mjs';
import {createJsonRoutes} from './json-http.mjs';

/** Dedicated coordinator credential: this endpoint cannot execute or mutate. */
export function createSourceInspectionHandler({machineId, credential, sources, reportError}) {
  if (!/^[a-f0-9]{64}$/.test(credential)) throw new TypeError('Invalid node credential');
  const expected = Buffer.from(credential, 'hex');
  const authenticate = async req => {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!supplied || !timingSafeEqual(Buffer.from(supplied, 'hex'), expected)) throw new ApplicationError('UNAUTHENTICATED');
    return {id: 'coordinator'};
  };
  const inspect = {async execute(_actor, request) {
    if (request.machineId !== machineId) throw new ApplicationError('SOURCE_NODE_MISMATCH');
    return readObservation(request, await sources.inspect(request));
  }};
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([[SOURCE_INSPECTION_ROUTE, {parse: parseDataReadRequest, useCase: inspect}]]),
    statuses: {UNAUTHENTICATED: 401, SOURCE_NODE_MISMATCH: 409, SOURCE_UNAVAILABLE: 503},
  });
}
