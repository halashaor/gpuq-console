import {readFile} from 'node:fs/promises';

// Installed clients are a single file. Inline our fixed pure modules while
// retaining ordinary Node imports; do not fetch code at client runtime.
export async function standaloneClient(origin='__GPUQ_PUBLIC_ORIGIN__'){
  const read=name=>readFile(new URL(name,import.meta.url),'utf8');
  const [cli,progress,watch]=await Promise.all([read('./cli.mjs'),read('./dist/job-progress.js'),read('./job-watch.mjs')]);
  const imports=["import {watchJob} from './job-watch.mjs';","import {progressText} from './dist/job-progress.js';"];
  if(imports.some(line=>!cli.includes(line)))throw Error('CLI shared module imports changed; update the standalone bundle');
  const watchImports=["import {setTimeout as delay} from 'node:timers/promises';",
    "import {JOB_TERMINAL,feedbackKey,jobFeedbackText,watchExitCode} from './dist/job-progress.js';"];
  if(watchImports.some(line=>!watch.includes(line)))throw Error('Watch dependencies changed; update the standalone bundle');
  const exported=source=>source.replace(/^export (?=(?:const|function|async function) )/gm,'');
  const progressExports=['JOB_TERMINAL','normalizeProgress','normalizeAttempt','applyJobFeedback','progressPercent','progressText','feedbackKey','jobFeedbackText','watchExitCode'];
  const module=`import {setTimeout as gpuqWatchDelay} from 'node:timers/promises';
const gpuqProgress=(()=>{${exported(progress)};return {${progressExports.join(',')}};})();
const {watchJob}=(()=>{const delay=gpuqWatchDelay;const {JOB_TERMINAL,feedbackKey,jobFeedbackText,watchExitCode}=gpuqProgress;
${exported(watchImports.reduce((source,line)=>source.replace(line,''),watch))};return {watchJob};})();
const {progressText}=gpuqProgress;`;
  return cli.replace(imports[0],module).replace(imports[1],'').replaceAll('__GPUQ_PUBLIC_ORIGIN__',origin);
}
