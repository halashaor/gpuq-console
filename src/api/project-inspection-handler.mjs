import {PROJECT_INSPECTION_ROUTE, PROJECT_RUNTIME_ROUTE, parseProjectInspection, parseProjectObservation, parseProjectRuntimeObservation} from '../contracts/project-inspection.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {createNodeAuthenticator} from './node-authenticator.mjs';
import {createJsonRoutes} from './json-http.mjs';

export function createProjectInspectionHandler({machineId, credential, projects, reportError}) {
  const observer = (read, parse) => ({async execute(_actor, input) {
    if (input.machineId !== machineId) throw new ApplicationError('PROJECT_NODE_MISMATCH');
    const result = parse(await read({machineId, project: input.project, release: input.release}, {actor: {id: input.accountId}}));
    if (result.accountId !== input.accountId || result.machineId !== machineId || result.project !== input.project || result.release !== input.release) {
      throw new ApplicationError('PROJECT_SOURCE_UNAVAILABLE');
    }
    return result;
  }});
  return createJsonRoutes({authenticate: createNodeAuthenticator(credential), reportError,
    routes: new Map([
      [PROJECT_INSPECTION_ROUTE, {parse: parseProjectInspection, useCase: observer((...args) => projects.inspect(...args), parseProjectObservation)}],
      [PROJECT_RUNTIME_ROUTE, {parse: parseProjectInspection, useCase: observer((...args) => projects.verifyRuntime(...args), parseProjectRuntimeObservation)}],
    ]),
    statuses: {UNAUTHENTICATED: 401, PROJECT_NODE_MISMATCH: 409, PROJECT_SOURCE_UNAVAILABLE: 503},
  });
}
