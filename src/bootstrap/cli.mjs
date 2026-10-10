import {parseArgs} from 'node:util';
import {openClientCredentials} from '../infrastructure/open-client-credentials.mjs';
import {JsonHttpTransport} from '../client/http-transport.mjs';
import {SessionClient} from '../client/session-client.mjs';
import {DataClient} from '../client/data-client.mjs';
import {AccountClient} from '../client/account-client.mjs';
import {DirectoryClient} from '../client/directory-client.mjs';

const usage = `V2 isolated client (not the installed gpuctl):
  --url ORIGIN --credentials FILE login --username NAME --password-stdin
  --url ORIGIN --credentials FILE current
  --url ORIGIN --credentials FILE logout
  --url ORIGIN --credentials FILE accounts [--after ID] [--limit 50]
  --url ORIGIN --credentials FILE register-directory --machine ID --source CONFIGURED_ID
  --url ORIGIN --credentials FILE read --machine ID --kind directory --source ID
  --url ORIGIN --credentials FILE read --machine ID --kind warehouse|cache --dataset ID --version SHA256
Credentials parent directory must already exist. Password is read from stdin, never an argument.
`;

async function readPassword(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new Error('PASSWORD_INPUT_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Explicit opt-in development entry. Does not start services or select a production default. */
export async function runCli({argv, stdin, stdout}) {
  const {values, positionals} = parseArgs({args: argv, allowPositionals: true, options: {
    url: {type: 'string'}, credentials: {type: 'string'}, username: {type: 'string'},
    'password-stdin': {type: 'boolean'}, help: {type: 'boolean'},
    machine: {type: 'string'}, kind: {type: 'string'}, source: {type: 'string'},
    dataset: {type: 'string'}, version: {type: 'string'},
    after: {type: 'string'}, limit: {type: 'string'},
  }});
  if (values.help) {stdout.write(usage); return;}
  const [command] = positionals;
  if (positionals.length !== 1 || !['login', 'current', 'logout', 'read', 'accounts', 'register-directory'].includes(command)
    || !values.url || !values.credentials) throw new Error('Specify command, --url and --credentials; see --help');
  if (command === 'login' && (!values.username || !values['password-stdin'])) {
    throw new Error('Login requires --username and --password-stdin');
  }
  // Validate destination before opening a local credential file.
  const transport = new JsonHttpTransport({baseUrl: values.url});
  transport.session.close();
  const store = openClientCredentials(values.credentials);
  try {
    const session = new SessionClient({transport, delivery: 'token', credentials: store.credentials});
    let result;
    if (command === 'login') {
      result = await session.login({username: values.username, password: await readPassword(stdin)});
    } else {
      const identity = await session.restore();
      if (command === 'logout') result = await session.logout();
      else {
        const expiry = await session.refresh();
        if (command === 'current') result = {...identity, ...expiry};
        else if (command === 'accounts') result = await new AccountClient({transport}).list({after: values.after ?? null, limit: values.limit === undefined ? 50 : Number(values.limit)});
        else if (command === 'register-directory') result = await new DirectoryClient({transport}).register({machineId: values.machine, sourceId: values.source});
        else {
          const source = values.kind === 'directory'
            ? {kind: values.kind, sourceId: values.source}
            : {kind: values.kind, datasetId: values.dataset, version: values.version};
          result = await new DataClient({transport}).resolveReadLocation({machineId: values.machine, source});
        }
      }
    }
    stdout.write(JSON.stringify(result) + '\n');
  } finally {
    store.close();
  }
}
