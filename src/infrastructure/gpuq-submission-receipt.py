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
        if not isinstance(value, dict) or set(value) not in ({'socketPath', 'submitKey'}, {'socketPath', 'submitKey', 'planId'}):
            raise ValueError('Invalid receipt query')
        path = Path(value['socketPath'])
        if not path.is_absolute():
            raise ValueError('Expected configured absolute socket')
        if 'planId' in value:
            receipt = Client(path, timeout=5).call('scale_up_receipt', {'submit_key': value['submitKey'], 'plan_id': value['planId']})
            fields = ('job_id', 'submit_key', 'submit_digest', 'plan_id', 'plan_state', 'plan_version',
                      'from_gpu_count', 'target_gpu_count', 'source_attempt_id', 'successor_attempt_id',
                      'source_attempt_state', 'successor_attempt_state', 'plan_reserved_gpu_count',
                      'job_reserved_gpu_count', 'job_leased_gpu_count')
        else:
            receipt = Client(path, timeout=5).call('submission_receipt', {'submit_key': value['submitKey']})
            fields = ('job_id', 'submit_key', 'submit_digest', 'owner', 'name', 'gpu_count', 'state')
        if receipt is not None:
            receipt = {key: receipt[key] for key in fields}
        print(json.dumps({'result': receipt}))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'GPUQ_RECEIPT_UNAVAILABLE'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
