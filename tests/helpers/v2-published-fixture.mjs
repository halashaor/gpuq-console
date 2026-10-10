import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdtemp, chmod, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ManagedSourceReader} from '../../src/infrastructure/managed-source-reader.mjs';

export const python = process.env.V2_PYTHON || 'python3';
const run = promisify(execFile);
async function writable(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await writable(child);
    else await chmod(child, 0o600);
  }
}

export async function publishedFixture(t, {owners = ['alice']} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'v2-published-'));
  t.after(async () => {await writable(directory); await rm(directory, {recursive: true, force: true});});
  const {stdout} = await run(python, ['-B', fileURLToPath(new URL('./v2-published-fixture.py', import.meta.url)), directory, JSON.stringify(owners)]);
  const {version} = JSON.parse(stdout);
  const roots = ['cache', 'warehouse'].map(kind => ({kind, root: join(directory, kind)}));
  const managed = new ManagedSourceReader({machineId: 'node-1', roots, python});
  const request = kind => ({machineId: 'node-1', source: {kind, datasetId: 'images', version}});
  return {directory, version, roots, managed, request};
}
