import {REGISTER_DIRECTORY_ROUTE, parseDirectoryRegistration} from '../contracts/directory-registration.mjs';
import {createJsonRoutes} from './json-http.mjs';

export function createDirectoryRegistrationHandler({authenticate, registerDirectory, reportError}) {
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([[REGISTER_DIRECTORY_ROUTE, {parse: parseDirectoryRegistration, useCase: registerDirectory}]]),
    statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, SOURCE_NOT_CONFIGURED: 404,
      MACHINE_NOT_FOUND: 404, ACCOUNT_NOT_FOUND: 404, SOURCE_REGISTRATION_CONFLICT: 409},
  });
}
