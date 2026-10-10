import {PROJECT_REGISTRATION_ROUTES, parseProjectRegistration} from '../contracts/project-registration.mjs';
import {createJsonRoutes} from './json-http.mjs';

export function createProjectRegistrationHandler({authenticate, registerProject, getRegistration, reportError}) {
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([
      [PROJECT_REGISTRATION_ROUTES.register, {parse: parseProjectRegistration, useCase: registerProject}],
      [PROJECT_REGISTRATION_ROUTES.get, {parse: parseProjectRegistration, useCase: getRegistration}],
    ]),
    statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, PROJECT_ARCHIVED: 409, PROJECT_NOT_ACTIVE: 409,
      PROJECT_INSTANCE_CONFLICT: 409, PROJECT_OBSERVATION_INVALID: 503, PROJECT_SOURCE_UNAVAILABLE: 503,
      PROJECT_NODE_UNAVAILABLE: 503, PROJECT_NODE_MISMATCH: 503},
  });
}
