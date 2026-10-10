"""Publish small, real legacy versions only inside a test-owned temporary root."""
import importlib.util
import json
from pathlib import Path
import sys

base = Path(sys.argv[1])
module_path = Path(__file__).resolve().parents[2] / 'deploy' / 'dataset-cache.py'
spec = importlib.util.spec_from_file_location('published_fixture_cache', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source = base / 'approved'
source.mkdir()
(source / 'sample.txt').write_text('original sample')
version = None
for kind in ('cache', 'warehouse'):
    cache = module.DatasetCache(base / kind, sources={'original': source}, reserve_bytes=0)
    version = cache.register_source(module.Principal('operator', True), 'images', 'original', ['alice'])['version']
    cache.materialize(module.Principal('alice', False), 'images', version)
    if kind == 'cache':
        with cache._locked():
            tier = cache._tier('images', version)
            tier['role'] = 'cache'
            cache._write_tier('images', version, tier)
print(json.dumps({'version': version}))
