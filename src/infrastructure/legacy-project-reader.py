"""Narrow compatibility adapter for existing project/release metadata.

No workspace creation, publication, image preparation or user-code execution.
This is an observation, not runtime admission or a held project lease.
"""


class LegacyProjectReader:
    def __init__(self, module, *, root, base_path, config=None):
        self._store = module.ProjectStore(root, base_path, config=config, initialize=False)

    def inspect(self, *, user_id, project, release):
        return self._store.inspect_release_metadata(user_id, project, release)

    def verify_runtime(self, *, user_id, project, release):
        return self._store.inspect_release_runtime(user_id, project, release)


def main():
    import importlib.util
    import json
    from pathlib import Path
    import sys
    sys.dont_write_bytecode = True
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('Project request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'operation', 'config', 'request'}:
            raise ValueError('Invalid project envelope')
        if value['operation'] not in ('inspect', 'runtime'):
            raise ValueError('Invalid project operation')
        config, request = value['config'], value['request']
        if not isinstance(config, dict) or set(config) != {'root', 'basePath', 'runtimeConfig'} or not isinstance(config['runtimeConfig'], dict):
            raise ValueError('Invalid project configuration')
        if not isinstance(request, dict) or set(request) != {'accountId', 'project', 'release'}:
            raise ValueError('Invalid project request')
        path = Path(__file__).resolve().parents[2] / 'deploy' / 'project-store.py'
        spec = importlib.util.spec_from_file_location('v2_existing_projects', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        reader = LegacyProjectReader(module, root=config['root'], base_path=config['basePath'],
                                     config={**config['runtimeConfig'], 'root': config['root']})
        observe = reader.inspect if value['operation'] == 'inspect' else reader.verify_runtime
        result = observe(user_id=request['accountId'], project=request['project'], release=request['release'])
        print(json.dumps({'result': {'accountId': request['accountId'], **result}}))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'PROJECT_SOURCE_UNAVAILABLE'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
