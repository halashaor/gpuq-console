"""Submission receipt recovery against real SQLite and native RPC; no GPU or systemd."""
import importlib.util
import json
import os
from pathlib import Path
import threading
import sys
import uuid
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location('submission_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq.protocol import Client
from gpuq.rpc import ApiError, _ThreadingUnixServer
from gpuq.store import Store, StoreConflictError, normalized_submission_digest
from gpuq.submission import validate_submission


class SubmissionReceiptTests(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    snapshot = F.SchedulerPriorityTests.snapshot

    def test_receipt_is_narrow_and_queries_do_not_mutate_database(self):
        job = self.submit(submit_key='11111111-1111-4111-8111-111111111111', env={'PRIVATE_TOKEN': 'do-not-return'})
        before = '\n'.join(self.store._get_connection().iterdump())
        result = self.coordinator.handle_api('submission_receipt', {'submit_key': '11111111-1111-4111-8111-111111111111'})
        self.assertEqual(set(result), {'job_id', 'submit_key', 'submit_digest', 'owner', 'name', 'gpu_count', 'state'})
        self.assertEqual(result['job_id'], job['id'])
        self.assertEqual(result['submit_key'], '11111111-1111-4111-8111-111111111111')
        self.assertTrue(result['submit_digest'])
        self.assertNotIn('do-not-return', json.dumps(result))
        self.assertIsNone(self.coordinator.handle_api('submission_receipt', {'submit_key': 'missing'}))
        self.assertEqual('\n'.join(self.store._get_connection().iterdump()), before)
        self.systemd.start.assert_not_called()

    def test_original_key_survives_reopen_and_preserves_native_idempotency(self):
        first = self.submit(submit_key='11111111-1111-4111-8111-111111111111')
        self.assertEqual(self.submit(submit_key='11111111-1111-4111-8111-111111111111')['id'], first['id'])
        with self.assertRaises(StoreConflictError):
            self.submit(submit_key='11111111-1111-4111-8111-111111111111', name='different')
        reopened = Store(self.config.db_path)
        try:
            self.assertEqual(reopened.get_submission_receipt('11111111-1111-4111-8111-111111111111')['job_id'], first['id'])
        finally:
            reopened.close()

    def test_lookup_is_read_only_even_when_release_mutations_are_disabled(self):
        self.submit(submit_key='11111111-1111-4111-8111-111111111111')
        with patch.object(self.coordinator, '_require_release_open', side_effect=AssertionError('mutation gate invoked')) as gate:
            self.assertIsNotNone(self.coordinator.handle_api('submission_receipt', {'submit_key': '11111111-1111-4111-8111-111111111111'}))
            gate.assert_not_called()
        self.assertIn('submission-receipt-v1', self.coordinator.handle_api('status', {})['daemon']['capabilities'])

    def test_request_shape_and_key_validation_match_native_store_bounds(self):
        for arguments in [{}, {'submit_key': ''}, {'submit_key': 1}, {'submit_key': 'x' * 257},
                          {'submit_key': 'x\0'}, {'submit_key': 'key', 'job_id': 'other'}]:
            with self.subTest(arguments=arguments), self.assertRaises(ApiError) as error:
                self.coordinator.handle_api('submission_receipt', arguments)
            self.assertEqual(error.exception.code, 'BAD_REQUEST')

    def test_real_native_socket_returns_original_job_without_resubmission(self):
        job = self.submit(submit_key='11111111-1111-4111-8111-111111111111')
        path = self.root / 'receipt.sock'
        server = _ThreadingUnixServer(path, self.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            result = Client(path, timeout=3).call('submission_receipt', {'submit_key': '11111111-1111-4111-8111-111111111111'})
            self.assertEqual(result['job_id'], job['id'])
            self.assertIsNone(Client(path, timeout=3).call('submission_receipt', {'submit_key': 'unknown'}))
            self.assertEqual(len(self.store.list_jobs()), 1)
        finally:
            server.shutdown(); server.server_close(); thread.join(5)
        self.assertFalse(thread.is_alive())

    def test_precomputed_digest_matches_actual_store_receipts_for_native_modes(self):
        cases = [{}, {'preempt_opt_in_only': True, 'yield_policy': 'now'},
                 {'gpu_count': 4, 'min_gpu_count': 1, 'elastic_gpu_count': True, 'auto_scale_up': True,
                  'target_global_batch_size': 64, 'per_device_micro_batch_size': 4,
                  'checkpoint_capability': 'epoch-v1', 'restart_policy': 'on-preempt', 'yield_policy': 'save'},
                 {'placement': 'pinned', 'requested_gpu_uuids': ['GPU-1'], 'share_gpu': True, 'vram_mb': 1024},
                 {'placement': 'pinned', 'requested_gpu_uuids': ['GPU-1'], 'share_gpu': True, 'vram_mb': 1024,
                  'hami_core': True, 'sm_percent': 30}]
        for case in cases:
            with self.subTest(case=case):
                raw = {'submit_key': str(uuid.uuid4()), 'name': 'digest-test', 'owner': 'test-user',
                       'priority': 2, 'dispatch_mode': 'queue', 'yield_policy': 'never',
                       'checkpoint_capability': 'none', 'restart_policy': 'never',
                       'gpu_count': 1, 'placement': 'any', 'requested_gpu_uuids': [],
                       'argv': [sys.executable, '-c', 'never executed'], 'cwd': str(self.root),
                       'env': {'Z': 'last', 'A': 'first'}, **case}
                clean = validate_submission(raw, 4, managed_gpu_uuids=self.config.managed_gpu_uuids)
                digest = normalized_submission_digest(clean)
                self.store.submit_job(clean)
                self.assertEqual(digest, self.store.get_submission_receipt(clean['submit_key'])['submit_digest'])
                self.assertEqual(digest, normalized_submission_digest({**clean, 'env': {'A': 'first', 'Z': 'last'}}))
                self.assertNotEqual(digest, normalized_submission_digest({**clean, 'argv': [*clean['argv'], '--different']}))

    def test_scale_receipt_is_available_over_the_real_read_only_native_socket(self):
        job = self.submit(gpu_count=4, min_gpu_count=1, elastic_gpu_count=True, auto_scale_up=True,
            target_global_batch_size=64, per_device_micro_batch_size=4, checkpoint_capability='epoch-v1',
            restart_policy='on-preempt', yield_policy='save')
        attempt_id = 'A' + uuid.uuid4().hex
        control, log = self.coordinator._create_attempt_paths(job['id'], attempt_id)
        attempt = self.store.create_attempt(job['id'], attempt_id=attempt_id, state='RUNNING',
            gpu_uuids=['GPU-0'], gpu_indices=[0], unit_name='gpuq-' + attempt_id.lower(), unit_token='attempt:' + attempt_id,
            boot_id='test-boot', invocation_id='a' * 32, control_dir=str(control), log_path=str(log))
        self.store.acquire_leases(job['id'], attempt_id, {'GPU-0': 0})
        self.store.update_attempt(attempt_id, state='RUNNING')
        self.store.update_job(job['id'], state='RUNNING')
        attempt = self.store.get_attempt(attempt_id)
        job = self.store.get_job(job['id'])
        plan = self.coordinator._plan_scale_up(job, attempt, [self.coordinator._snapshot[1]])
        path = self.root / 'scale-receipt.sock'
        server = _ThreadingUnixServer(path, self.coordinator.handle_api, os.getuid(), 262144)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            receipt = Client(path, timeout=3).call('scale_up_receipt', {'submit_key': job['submit_key'], 'plan_id': plan['id']})
            self.assertEqual(receipt['target_gpu_count'], 2)
            self.assertEqual(receipt['job_leased_gpu_count'], 1)
            self.assertEqual(receipt['plan_reserved_gpu_count'], 1)
        finally:
            server.shutdown(); server.server_close(); thread.join(5)
        self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()
