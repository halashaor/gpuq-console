"""Fixed read-only native receipt query; no submit or status-list fallback."""
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
        if not isinstance(value, dict) or set(value) != {'socketPath', 'submitKey'}:
            raise ValueError('Invalid receipt query')
        path = Path(value['socketPath'])
        if not path.is_absolute():
            raise ValueError('Expected configured absolute socket')
        receipt = Client(path, timeout=5).call('submission_receipt', {'submit_key': value['submitKey']})
        if receipt is not None:
            receipt = {key: receipt[key] for key in ('job_id', 'submit_key', 'submit_digest', 'owner', 'name', 'gpu_count', 'state')}
        print(json.dumps({'result': receipt}))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'GPUQ_RECEIPT_UNAVAILABLE'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
