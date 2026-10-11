"""Native allocation-authority schema boundary; temporary SQLite only."""
import importlib.util
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location('authority_fixture', Path(__file__).with_name('gpuq-priority.test.py'))
F = importlib.util.module_from_spec(loader); loader.loader.exec_module(F)
from gpuq import store as S
from gpuq.store import Store, StoreSchemaError


class AllocationAuthoritySchema(unittest.TestCase):
    setUp = F.SchedulerPriorityTests.setUp
    submit = F.SchedulerPriorityTests.submit
    snapshot = F.SchedulerPriorityTests.snapshot

    def old_database(self):
        job = self.submit()
        row = dict(self.store._get_connection().execute('SELECT * FROM jobs WHERE id=?', (job['id'],)).fetchone())
        row.pop('allocation_authority')
        path = self.root / 'old-v13.sqlite'
        connection = sqlite3.connect(path)
        try:
            for statement in S._SCHEMA_V2_STATEMENTS:
                connection.execute(statement)
            for version in range(2, 13):
                for statement in getattr(S, f'_SCHEMA_V{version}_TO_V{version+1}_DDL'):
                    connection.execute(statement)
            connection.execute('INSERT INTO schema_meta VALUES(1,13,1)')
            connection.execute(f'PRAGMA application_id={S.APPLICATION_ID}')
            connection.execute('PRAGMA user_version=13')
            fields = ','.join(row)
            connection.execute(f'INSERT INTO jobs({fields}) VALUES({",".join("?" for _ in row)})', tuple(row.values()))
            connection.commit()
        finally:
            connection.close()
        return path, job, row['submit_digest']

    def test_explicit_v13_upgrade_preserves_native_jobs_and_original_submission_identity(self):
        path, job, digest = self.old_database()
        old = Store(path)
        with self.assertRaises(StoreSchemaError):
            old.get_job(job['id'])
        old.initialize()
        try:
            self.assertEqual(old.check_integrity()['schema_version'], 14)
            self.assertEqual(old.get_allocation_authorization(job['id']), {'mode': 'native', 'grant': None})
            self.assertEqual(old.get_submission_receipt(job['submit_key'])['submit_digest'], digest)
            keys = ('submit_key','name','owner','priority','dispatch_mode','checkpoint_capability','restart_policy',
                    'gpu_count','placement','requested_gpu_uuids','argv','cwd','env','yield_policy')
            self.assertEqual(old.submit_job({key: job[key] for key in keys})['id'], job['id'])
        finally:
            old.close()

    def test_authority_marker_distinguishes_missing_and_zero_grants_without_implicitly_enrolling_native_jobs(self):
        job = self.submit()
        self.assertEqual(self.store.get_allocation_authorization(job['id'])['mode'], 'native')
        db = self.store._get_connection()
        db.execute("UPDATE jobs SET allocation_authority='external-v1' WHERE id=?", (job['id'],))
        self.assertEqual(self.store.get_allocation_authorization(job['id']), {'mode': 'external-v1', 'grant': None})
        db.execute('INSERT INTO allocation_grants VALUES(?,?,?,?)', (job['id'], 'grant-fixture', 1, 0))
        self.assertEqual(self.store.get_allocation_authorization(job['id']),
                         {'mode': 'external-v1', 'grant': {'grant_id': 'grant-fixture', 'revision': 1, 'max_gpu_count': 0}})
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute('UPDATE jobs SET allocation_authority=NULL WHERE id=?', (job['id'],))

    def test_v13_reader_contract_rejects_new_authority_schema(self):
        with self.assertRaises(StoreSchemaError):
            self.store._validate_schema_version(self.store._get_connection(), version=13,
                                                expected_signature=S._EXPECTED_SCHEMA_SIGNATURE_V13)

    def test_failed_upgrade_rolls_back_all_columns_tables_and_version(self):
        path, job, _ = self.old_database()
        with patch.object(S, '_SCHEMA_V13_TO_V14_DDL', (*S._SCHEMA_V13_TO_V14_DDL, 'INVALID MIGRATION SQL')):
            with self.assertRaises(Exception):
                Store(path).initialize()
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 13)
            self.assertNotIn('allocation_authority', [row[1] for row in db.execute('PRAGMA table_info(jobs)')])
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='allocation_grants'").fetchone())
        reopened = Store(path).initialize()
        try:
            self.assertEqual(reopened.get_job(job['id'])['id'], job['id'])
            self.assertEqual(reopened.check_integrity()['schema_version'], 14)
        finally:
            reopened.close()


if __name__ == '__main__':
    unittest.main()
