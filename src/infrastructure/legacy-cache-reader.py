"""Read-only adapter for existing cache publication metadata.

This compatibility boundary reuses manifest, ownership, deletion and READY
checks, not node-executor or its workspace/quota/preparation orchestration.
Retire it when the publication catalogue is migrated, not by guessing READY.
The injected module is the installed, trusted dataset-cache implementation.
"""


class LegacyCacheReader:
    def __init__(self, module, *, root, kind, mount_point=None, lock_timeout=2.0):
        if kind not in ('cache', 'warehouse'):
            raise ValueError('Invalid configured managed source kind')
        self._kind = kind
        self._module = module
        self._cache = module.DatasetCache(
            root, mount_point=mount_point, lock_timeout=lock_timeout, initialize=False)

    def inspect(self, *, user_id, dataset, version, kind):
        if kind != self._kind:
            raise ValueError('Managed source differs from configured kind')
        actor = self._module.Principal(user_id, False)
        status, _ = self._cache._status_snapshot(
            actor, dataset, version, require_protected=kind == 'warehouse')
        return {'dataset': dataset, 'version': version, 'kind': kind,
                'availability': 'available' if status['state'] == 'READY' else 'unavailable',
                **({} if status['state'] == 'READY' else {'reason': 'not-ready'})}
