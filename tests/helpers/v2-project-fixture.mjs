import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdtemp, readdir, chmod, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectMetadataReader} from '../../src/infrastructure/project-metadata-reader.mjs';

const run = promisify(execFile);
export const python = process.env.V2_PYTHON || 'python3';
async function writableDirectories(path) {
  await chmod(path, 0o700);
  for (const item of await readdir(path, {withFileTypes: true})) {
    if (item.isDirectory()) await writableDirectories(join(path, item.name));
  }
}
export async function projectFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'v2-project-'));
  t.after(async () => {await writableDirectories(directory); await rm(directory, {recursive: true, force: true});});
  const {stdout} = await run(python, ['-B', fileURLToPath(new URL('./v2-project-fixture.py', import.meta.url)), directory]);
  const config = JSON.parse(stdout);
  return {...config, directory, request: {machineId: 'node-1', project: 'training', release: config.release},
    reader: new ProjectMetadataReader({machineId: 'node-1', ...config, python})};
}
