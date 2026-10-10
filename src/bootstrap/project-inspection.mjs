import {ProjectMetadataReader} from '../infrastructure/project-metadata-reader.mjs';
import {createProjectInspectionHandler} from '../api/project-inspection-handler.mjs';

export function assembleProjectInspection({machineId, credential, root, basePath, python, timeoutMs, reportError}) {
  return createProjectInspectionHandler({machineId, credential, reportError,
    projects: new ProjectMetadataReader({machineId, root, basePath, python, timeoutMs})});
}
