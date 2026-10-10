import {ResolveDataRead} from '../application/resolve-data-read.mjs';
import {createDataReadHandler} from '../api/data-read-handler.mjs';

// Composition only. Does not start listeners, open a database or read globals.
export function assembleDataRead({authenticate,access,sources,reportError}){
  const resolveDataRead=new ResolveDataRead({access,sources});
  return createDataReadHandler({authenticate,resolveDataRead,reportError});
}
