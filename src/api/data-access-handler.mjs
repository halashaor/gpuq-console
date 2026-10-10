import {DATA_ACCESS_ROUTES, parseDataAccessQuery, parseDataReaders} from '../contracts/data-access.mjs';
import {createJsonRoutes} from './json-http.mjs';

const statuses = {UNAUTHENTICATED: 401, FORBIDDEN: 403, DATA_RESOURCE_NOT_FOUND: 404, ACCOUNT_NOT_FOUND: 404,
  DATA_ACCESS_CHANGED: 409, DATA_SOURCE_SHARED: 409};

export function createDataAccessHandler({authenticate, getAccess, setReaders, reportError = console.error}) {
  const routes = new Map([
    [DATA_ACCESS_ROUTES.get, {parse: parseDataAccessQuery, useCase: getAccess}],
    [DATA_ACCESS_ROUTES.set, {parse: parseDataReaders, useCase: setReaders}],
  ]);
  return createJsonRoutes({routes, authenticate, statuses, reportError});
}
