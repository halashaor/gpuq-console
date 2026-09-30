"""Real local SQLite receipts and cancellation fences; no GPUs/systemd/network."""
import importlib.util
from pathlib import Path
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
import threading
from unittest.mock import patch,Mock
from contextlib import redirect_stdout
import io

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('fleet_admission_fixture',ROOT/'tests/gpuq-priority.test.py')
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
from gpuq import cli

class Admission(unittest.TestCase):
    setUp=F.SchedulerPriorityTests.setUp
    snapshot=F.SchedulerPriorityTests.snapshot
    submit=F.SchedulerPriorityTests.submit
    running=F.SchedulerPriorityTests.running
    pinned=F.SchedulerPriorityTests.pinned
    def payload(self):
        return {'token':str(uuid.uuid4()),'allow_preempt':False,'submission':{'submit_key':str(uuid.uuid4()),'name':'test','owner':'alice','priority':2,'dispatch_mode':'queue','yield_policy':'never','checkpoint_capability':'none','restart_policy':'never','gpu_count':1,'placement':'any','requested_gpu_uuids':[],'argv':['/usr/bin/python3','-c','pass'],'cwd':str(self.root),'env':{}}}

    def test_cancel_before_admit_writes_durable_tombstone_and_cannot_start_late(self):
        self.coordinator._health='ok';payload=self.payload()
        canceled=self.coordinator.handle_api('fleet_cancel_admission',payload)
        self.assertEqual(canceled,{'accepted':False,'canceled':True,'reason':'canceled before admission'})
        self.assertEqual(self.coordinator.handle_api('fleet_admit',payload),canceled)
        self.store.close();self.store.open()
        self.assertEqual(self.coordinator.handle_api('fleet_admit',payload),canceled)
        self.assertEqual(self.store.list_jobs(),[]);self.assertEqual(self.store.list_leases(),[]);self.assertEqual(self.store.list_actions(),[])
        with self.assertRaisesRegex(ValueError,'different payload'):self.coordinator.handle_api('fleet_admit',{**payload,'allow_preempt':True})

    def test_accepted_cancel_never_turns_receipt_into_a_rejection_and_keeps_start_lease(self):
        self.coordinator._health='ok';payload=self.payload()
        admitted=self.coordinator.handle_api('fleet_admit',payload);self.assertTrue(admitted['accepted']);jobid=admitted['job_id']
        canceled=self.coordinator.handle_api('fleet_cancel_admission',payload)
        self.assertTrue(canceled['accepted']);self.assertEqual(canceled['job_id'],jobid)
        self.assertEqual(self.coordinator.handle_api('fleet_admit',payload),admitted)
        self.assertEqual(self.store.get_job(jobid)['state'],'CANCELED')
        self.assertEqual(len(self.store.list_leases()),1,'START may already be in flight; cancellation must not release it')

    def test_cancel_and_admit_race_have_only_one_serialized_outcome(self):
        self.coordinator._health='ok';payload=self.payload();barrier=threading.Barrier(2)
        def call(operation):barrier.wait();return self.coordinator.handle_api(operation,payload)
        with ThreadPoolExecutor(2) as pool:
            a=pool.submit(call,'fleet_admit');b=pool.submit(call,'fleet_cancel_admission');admitted,canceled=a.result(),b.result()
        replay=self.coordinator.handle_api('fleet_admit',payload)
        if admitted['accepted']:
            self.assertTrue(canceled['accepted']);self.assertEqual(replay['job_id'],admitted['job_id']);self.assertEqual(len(self.store.list_jobs()),1);self.assertEqual(self.store.get_job(replay['job_id'])['state'],'CANCELED')
        else:self.assertEqual(replay,canceled);self.assertEqual(self.store.list_jobs(),[])

    def test_offers_are_readonly_and_explicitly_disable_preemption(self):
        self.coordinator._health='ok';payload=self.payload();submission=payload['submission']
        self.running((0,1,2,3),priority=0,yield_policy='now')
        before=(self.store.list_jobs(),self.store.list_leases(),self.store.list_actions(),self.store.list_settings())
        self.assertEqual(self.coordinator.handle_api('fleet_offer',{'submission':submission,'allow_preempt':False})['kind'],'busy')
        self.assertEqual(self.coordinator.handle_api('fleet_offer',{'submission':submission,'allow_preempt':True})['kind'],'preempt')
        self.assertEqual((self.store.list_jobs(),self.store.list_leases(),self.store.list_actions(),self.store.list_settings()),before)

    def test_cli_offer_admit_and_cancel_forward_one_prepared_submission(self):
        payload=self.payload();client=Mock();client.call.return_value={'accepted':False}
        for flags,operation in ((['--offer-only'],'fleet_offer'),(['--admission-token',payload['token']],'fleet_admit'),(['--admission-token',payload['token'],'--cancel-admission'],'fleet_cancel_admission')):
            args=cli.build_parser().parse_args(['submit','-g','1',*flags,'--admission-preempt','--','/usr/bin/python3','-c','pass'])
            with patch.object(cli,'prepare_submission',return_value=(self.config,payload['submission'])),patch.object(cli,'Client',return_value=client),redirect_stdout(io.StringIO()):cli.cmd_submit(args)
            op,body=client.call.call_args.args;self.assertEqual(op,operation);self.assertEqual(body['submission'],payload['submission']);self.assertIs(body['allow_preempt'],True)

if __name__=='__main__':unittest.main()
