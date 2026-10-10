"""Read the existing daemon through its native protocol; never change state."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.protocol import Client


def main():
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('Request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'socketPath'}:
            raise ValueError('Invalid pool query')
        path = Path(value['socketPath'])
        if not path.is_absolute():
            raise ValueError('Expected configured absolute socket')
        status = Client(path, timeout=5).call('status', {'limit': 1})
        daemon = status['daemon']
        # Do not infer free capacity from a truncated job list, memory usage or
        # GPU indices. The daemon owns the allocation/quarantine calculation.
        result = {
            'bootId': daemon['boot_id'], 'health': daemon['health'],
            'observeOnly': daemon['observe_only'],
            'releaseGateOpen': daemon['native_release_gate']['state'] == 'ABSENT'
                               and daemon['native_release_gate']['valid'] is True,
            'gpuUuids': daemon['managed_gpu_uuids'],
            'freeGpuUuids': daemon['schedulable_gpu_uuids'],
        }
        print(json.dumps({'result': result}))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'GPU_POOL_UNAVAILABLE'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
