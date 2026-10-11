"""Validate a node-built native submission and compute its original Store digest.

Checks paths but never executes the command, opens a database or contacts GPUQ.
"""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.submission import validate_submission, validate_resource_request
from gpuq.store import normalized_submission_digest


def main():
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'submission', 'gpuUuids', 'maxRequestBytes'}:
            raise ValueError('Invalid launch envelope')
        submission = validate_submission(value['submission'], len(value['gpuUuids']),
            managed_gpu_uuids=tuple(value['gpuUuids']), max_request_bytes=value['maxRequestBytes'])
        counts = validate_resource_request(submission, len(value['gpuUuids']), managed_gpu_uuids=tuple(value['gpuUuids']))['allowed_gpu_counts']
        print(json.dumps({'result': {'submission': submission, 'nativeDigest': normalized_submission_digest(submission),
                                     'allowedGpuCounts': list(counts)}}, sort_keys=True))
        return 0
    except ValueError:
        print(json.dumps({'error': {'code': 'INVALID_NATIVE_SUBMISSION'}}))
        return 1
    except Exception:
        print(json.dumps({'error': {'code': 'NATIVE_SUBMISSION_UNAVAILABLE'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
