"""Fixed managed operations only. Transport loss may follow a committed mutation."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.protocol import Client, ProtocolError, encode_request

REJECTIONS = {'BAD_REQUEST', 'BAD_SUBMISSION', 'ALLOCATION_CONFLICT', 'MAINTENANCE', 'NOT_FOUND', 'FORBIDDEN'}
OPERATIONS = {'submit': ('submit_managed', {'submission', 'grant_id', 'max_gpu_count'}),
              'status': ('allocation_status', {'submit_key'}),
              'update': ('set_allocation_grant', {'submit_key', 'grant_id', 'expected_revision', 'max_gpu_count'})}


def main():
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'socketPath', 'operation', 'args', 'maxRequestBytes'}:
            raise ValueError('Invalid managed envelope')
        operation, fields = OPERATIONS[value['operation']]
        args = value['args']
        if not isinstance(args, dict) or set(args) != fields:
            raise ValueError('Invalid operation fields')
        path = Path(value['socketPath'])
        if not path.is_absolute():
            raise ValueError('Expected configured absolute socket')
        client = Client(path, timeout=5, max_request_bytes=value['maxRequestBytes'])
        if len(encode_request(operation, args, '00000000-0000-4000-8000-000000000000')) > client.max_request_bytes:
            raise ValueError('Managed wire request too large')
    except Exception:
        print(json.dumps({'error': {'code': 'INVALID_MANAGED_REQUEST'}}))
        return 1
    try:
        result = client.call(operation, args)
        if value['operation'] == 'submit':
            result = {'job_id': result['job_id'], 'submit_key': args['submission']['submit_key'], **result['allocation']}
        if result is not None:
            result = {key: result[key] for key in ('job_id', 'submit_key', 'mode', 'grant')}
            if result['grant'] is not None:
                result['grant'] = {key: result['grant'][key] for key in ('grant_id', 'revision', 'max_gpu_count')}
        print(json.dumps({'result': result}))
        return 0
    except ProtocolError as error:
        code = 'NATIVE_OPERATION_REJECTED' if error.code in REJECTIONS else 'NATIVE_OUTCOME_UNCONFIRMED'
        print(json.dumps({'error': {'code': code, 'nativeCode': error.code if error.code in REJECTIONS else None}}))
        return 1
    except Exception:
        print(json.dumps({'error': {'code': 'NATIVE_OUTCOME_UNCONFIRMED'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
