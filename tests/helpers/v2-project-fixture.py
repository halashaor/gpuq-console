"""Publish synthetic project metadata without executing its fake interpreter."""
import importlib.util
import json
from pathlib import Path
import sys

folder = Path(sys.argv[1])
root, base = folder / 'service', folder / 'approved-base'
root.mkdir(mode=0o700); base.mkdir()
(base / 'bin').mkdir(); (base / 'bin/python3.12').write_bytes(b'fixture interpreter, never executed')
(base / 'bin/python').symlink_to('python3.12')
(base / 'conda-meta').mkdir()
(base / 'conda-meta/python.json').write_text(json.dumps({'name': 'python', 'version': '3.12.1'}))
(base / 'lib/python3.12/site-packages').mkdir(parents=True)
path = Path(__file__).resolve().parents[2] / 'deploy' / 'project-store.py'
spec = importlib.util.spec_from_file_location('fixture_projects', path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
store = module.ProjectStore(root, base, reserve_bytes=0)
store.create('alice', 'training')
dev = store.dev_paths('alice', 'training')
(dev['code'] / 'train.py').write_text('print("never executed")\n')
(dev['env'] / 'pyvenv.cfg').write_text('home = /opt/conda/bin\nversion = 3.12.1\n')
(dev['env'] / 'bin').mkdir(); (dev['env'] / 'bin/python').symlink_to('/opt/conda/bin/python')
(dev['env'] / 'lib/python3.12/site-packages').mkdir(parents=True)
(dev['env'] / 'lib64').symlink_to('lib')
published = store.publish('alice', 'training')
print(json.dumps({'root': str(root), 'basePath': str(base), 'release': published['release']}))
