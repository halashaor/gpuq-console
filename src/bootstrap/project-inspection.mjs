import {ExistingProjectReader} from '../infrastructure/existing-project-reader.mjs';
import {createProjectInspectionHandler} from '../api/project-inspection-handler.mjs';

export function assembleProjectInspection({machineId, credential, root, basePath, runtimeConfig, python, timeoutMs, reportError}) {
  return createProjectInspectionHandler({machineId, credential, reportError,
    projects: new ExistingProjectReader({machineId, root, basePath, runtimeConfig, python, timeoutMs})});
}
