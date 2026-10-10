import {PROJECT_INSPECTION_ROUTE, parseProjectInspection, parseProjectObservation} from '../contracts/project-inspection.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {createJsonRoutes} from './json-http.mjs';

export function createProjectInspectionHandler({machineId, credential, projects, reportError}) {
  const inspect = {async execute(_actor, input) {
    if (input.machineId !== machineId) throw new ApplicationError('PROJECT_NODE_MISMATCH');
    const result = parseProjectObservation(await projects.inspect({machineId, project: input.project, release: input.release}, {actor: {id: input.accountId}}));
    if (result.accountId !== input.accountId || result.machineId !== machineId || result.project !== input.project || result.release !== input.release) {
      throw new ApplicationError('PROJECT_SOURCE_UNAVAILABLE');
    }
    return result;
  }};
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([[PROJECT_INSPECTION_ROUTE, {parse: parseProjectInspection, useCase: inspect}]]),
    statuses: {UNAUTHENTICATED: 401, PROJECT_NODE_MISMATCH: 409, PROJECT_SOURCE_UNAVAILABLE: 503},
  });
}
