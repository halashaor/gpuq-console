"""Pure GPUQ policy bridge. No daemon, database, GPU probe or process actions."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.elastic import compatible_world_sizes, plan_elastic_batch
from gpuq.policy import VictimCandidate, preemption_mode, queue_sort_key, select_scale_target, select_victims


def count(value, name, minimum=0):
    # Cost bound for a single-node preview, not a guessed physical capacity.
    if type(value) is not int or not minimum <= value <= 4096:
        raise ValueError(name)
    return value


def priority(value):
    if type(value) is not int or not 0 <= value <= 4:
        raise ValueError('priority')
    return value


def evaluate(operation, args):
    if operation == 'elastic':
        minimum = count(args['min_gpu_count'], 'min_gpu_count', 1)
        maximum = count(args['max_gpu_count'], 'max_gpu_count', 1)
        free = count(args['free_gpu_count'], 'free_gpu_count')
        target, micro = args['target_global_batch_size'], args['per_device_micro_batch_size']
        if any(type(value) is not int or not 1 <= value <= 2**53 - 1 for value in (target, micro)):
            raise ValueError('batch parameters must fit exact JSON integers')
        allowed = compatible_world_sizes(target, micro, minimum, maximum)
        plans = [plan_elastic_batch(target, micro, world_size=n, environ={}) for n in allowed]
        current = args['current_gpu_count']
        scale = None if current is None else select_scale_target(
            current_gpu_count=count(current, 'current_gpu_count', 1), free_gpu_count=free, allowed_gpu_counts=allowed)
        return dict(allowedGpuCounts=list(allowed), launchGpuCount=max((n for n in allowed if n <= free), default=None),
                    scaleTarget=scale, batchPlans=[dict(gpuCount=p.world_size, accumulationSteps=p.gradient_accumulation_steps,
                    effectiveGlobalBatch=p.effective_global_batch_size, lrScale=p.lr_linear_scale) for p in plans])
    if operation == 'preemption':
        values = dict(args)
        priority(values['requester_priority'])
        maximum = count(values['requester_gpu_count'], 'requester_gpu_count', 1)
        minimum = count(values.get('requester_min_gpu_count', maximum), 'requester_min_gpu_count', 1)
        free = count(values['free_gpu_count'], 'free_gpu_count')
        candidates = []
        for row in values.pop('candidates'):
            priority(row['priority']); count(row['gpu_count'], 'gpu_count', 1)
            candidates.append(VictimCandidate(**row))
        if len({row.attempt_id for row in candidates}) != len(candidates):
            raise ValueError('duplicate attempt')
        required = values.get('required_gpu_uuids')
        if required is not None:
            if len(set(required)) != len(required):
                raise ValueError('duplicate pinned GPU')
            values['required_gpu_uuids'] = frozenset(required)
        if 'free_gpu_uuids' in values:
            values['free_gpu_uuids'] = frozenset(values['free_gpu_uuids'])
        selected = select_victims(candidates=candidates, **values)
        satisfied = free + sum(row.gpu_count for row in selected) >= minimum
        if required is not None:
            released = set(values.get('free_gpu_uuids', ())).union(*(row.gpu_uuids for row in selected))
            satisfied = set(required).issubset(released)
        return dict(satisfied=satisfied, victims=[dict(jobId=row.job_id, attemptId=row.attempt_id,
                    mode=preemption_mode(values['dispatch_mode'], row), gpuCount=row.gpu_count) for row in selected])
    if operation == 'queue':
        jobs = args['jobs']
        for job in jobs:
            priority(job['priority'])
            if type(job['sequence']) is not int or job['sequence'] < 0:
                raise ValueError('sequence')
        return dict(jobIds=[job['id'] for job in sorted(jobs, key=queue_sort_key)])
    raise ValueError('unknown policy operation')


def main():
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('request too large')
        request = json.loads(raw)
        if not isinstance(request, dict) or set(request) != {'operation', 'args'}:
            raise ValueError('invalid envelope')
        result = evaluate(request['operation'], request['args'])
        print(json.dumps({'result': result}))
        return 0
    except (ValueError, TypeError, KeyError):
        print(json.dumps({'error': {'code': 'INVALID_SCHEDULING_REQUEST'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
