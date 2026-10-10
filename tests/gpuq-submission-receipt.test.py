"""Submission receipt recovery against real SQLite and native RPC; no GPU or systemd."""
import importlib.util
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location('submission_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader)
loader.loader.exec_module(F)
from gpuq.protocol import Client
from gpuq.rpc import ApiError, _ThreadingUnixServer
from gpuq.store import Store, StoreConflictError


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


if __name__ == '__main__':
    unittest.main()
