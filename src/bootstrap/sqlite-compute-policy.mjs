import {GetComputePolicy, SetComputePolicy} from '../application/compute-policy.mjs';
import {AuthenticateSession} from '../application/authenticate-session.mjs';
import {SqliteComputePolicies} from '../infrastructure/sqlite/compute-policies.mjs';
import {SqliteSessionReader} from '../infrastructure/sqlite/session-reader.mjs';
import {createSessionAuthenticator} from '../api/session-authenticator.mjs';
import {createComputePolicyHandler} from '../api/compute-policy-handler.mjs';

export function assembleSqliteComputePolicy({database, publicOrigin, clock = Date.now, reportError}) {
  const policies = new SqliteComputePolicies({database});
  const authenticateSession = new AuthenticateSession({sessions: new SqliteSessionReader({database}), clock});
  return createComputePolicyHandler({
    authenticate: createSessionAuthenticator({authenticateSession, publicOrigin}), reportError,
    getPolicy: new GetComputePolicy({policies, clock}), setPolicy: new SetComputePolicy({policies, clock}),
  });
}
