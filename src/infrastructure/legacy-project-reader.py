"""Narrow compatibility adapter for existing project/release metadata.

No workspace creation, publication, image preparation or user-code execution.
This is an observation, not runtime admission or a held project lease.
"""


class LegacyProjectReader:
    def __init__(self, module, *, root, base_path, config=None):
        self._store = module.ProjectStore(root, base_path, config=config, initialize=False)

    def inspect(self, *, user_id, project, release):
        return self._store.inspect_release_metadata(user_id, project, release)
