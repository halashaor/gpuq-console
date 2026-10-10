import {runCli} from '../src/bootstrap/cli.mjs';

try {
  await runCli({argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout});
} catch (error) {
  console.error(error.code || error.message);
  process.exitCode = 1;
}
