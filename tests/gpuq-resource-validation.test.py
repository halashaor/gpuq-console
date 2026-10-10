"""Shared pure/full submission validation; no daemon, GPU or executable launch."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'gpuq'))
from gpuq import submission as S
from gpuq.policy import validate_yield_policy


class SharedResourceValidation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pool = tuple(f'GPU-{n}' for n in range(8))

    def request(self, **changes):
        return dict(submit_key=str(uuid.uuid4()), name='train', owner='member', priority=2,
                    dispatch_mode='queue', checkpoint_capability='none', restart_policy='never',
                    yield_policy='never', gpu_count=1, placement='any', requested_gpu_uuids=[],
                    argv=[sys.executable, '-c', 'pass'], cwd=self.temp.name, env={}, **changes)

    def pure(self, raw):
        validated = S.validate_resource_request(raw, 8, managed_gpu_uuids=self.pool)
        resource = validated['submission']
        runtime = S.validate_runtime_environment(raw, resource['share_gpu'])
        return {**resource, **runtime, 'yield_policy': validate_yield_policy(
            raw.get('yield_policy', 'legacy'), resource['checkpoint_capability'], resource['share_gpu'])}

    def test_full_submission_keeps_its_exact_canonical_fields_and_defaults(self):
        raw = self.request()
        expected = {**raw, 'preempt_idle_only': False, 'share_gpu': False, 'vram_mb': None,
                    'min_gpu_count': 1, 'elastic_gpu_count': False, 'auto_scale_up': False,
                    'target_global_batch_size': None, 'per_device_micro_batch_size': None,
                    'hami_core': False, 'sm_percent': None}
        self.assertEqual(S.validate_submission(raw, 8, managed_gpu_uuids=self.pool), expected)
        raw['preempt_opt_in_only'] = False
        self.assertNotIn('preempt_opt_in_only', S.validate_submission(raw, 8))
        raw['preempt_opt_in_only'] = True
        self.assertIs(S.validate_submission(raw, 8)['preempt_opt_in_only'], True)

    def test_pure_validation_never_resolves_or_stats_cwd_or_executable(self):
        raw = self.request()
        raw.update(cwd='/does/not/exist', argv=['/also/not/present'])
        with patch.object(S.Path, 'resolve', side_effect=AssertionError('no path resolution')), \
                patch.object(S.Path, 'stat', side_effect=AssertionError('no filesystem stat')):
            self.assertEqual(self.pure(raw)['gpu_count'], 1)
        with self.assertRaises(ValueError):
            S.validate_submission(raw, 8)

    def test_invalid_combinations_match_the_original_full_entrypoint_errors(self):
        cases = [
            dict(min_gpu_count=2),
            dict(auto_scale_up=True),
            dict(yield_policy='save'),
            dict(placement='pinned', requested_gpu_uuids=['GPU-outside']),
            dict(share_gpu=True, vram_mb=1024),
            dict(env={'GPUQ_WORLD_SIZE': '4'}),
        ]
        for changes in cases:
            raw = self.request(); raw.update(changes)
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError) as pure:
                    self.pure(raw)
                with self.assertRaises(ValueError) as full:
                    S.validate_submission(raw, 8, managed_gpu_uuids=self.pool)
                self.assertEqual(str(pure.exception), str(full.exception))

    def test_valid_elastic_and_hami_fields_match_between_both_callers(self):
        cases = [
            dict(gpu_count=8, min_gpu_count=3, elastic_gpu_count=True, auto_scale_up=True,
                 target_global_batch_size=64, per_device_micro_batch_size=4,
                 checkpoint_capability='epoch-v1', restart_policy='on-preempt', yield_policy='save'),
            dict(placement='pinned', requested_gpu_uuids=['GPU-2'], share_gpu=True,
                 vram_mb=1024, hami_core=True, sm_percent=30),
        ]
        for changes in cases:
            raw = self.request(); raw.update(changes)
            pure = self.pure(raw); full = S.validate_submission(raw, 8, managed_gpu_uuids=self.pool)
            self.assertEqual({key: full[key] for key in pure}, pure)
        elastic = self.request(); elastic.update(cases[0])
        self.assertEqual(S.validate_resource_request(elastic, 8)['allowed_gpu_counts'], (4, 8))


if __name__ == '__main__':
    unittest.main()
