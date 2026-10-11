"""Real SQLite lease/outbox scale plans; mocked hardware, no GPU/daemon calls."""
import importlib.util
from pathlib import Path
import unittest
import uuid
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('elastic_native_fixture',ROOT/'tests/gpuq-priority.test.py')
F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
from gpuq.constants import AttemptState
from gpuq.rpc import ApiError
from gpuq.store import StoreConflictError

class NativeExpansion(unittest.TestCase):
    setUp=F.SchedulerPriorityTests.setUp
    snapshot=F.SchedulerPriorityTests.snapshot
    submit=F.SchedulerPriorityTests.submit

    def running_elastic(self):
        job=self.submit(gpu_count=4,min_gpu_count=1,elastic_gpu_count=True,auto_scale_up=True,target_global_batch_size=256,per_device_micro_batch_size=8,yield_policy='save',checkpoint_capability='epoch-v1',restart_policy='on-preempt')
        aid='A'+uuid.uuid4().hex;control,log=self.coordinator._create_attempt_paths(job['id'],aid)
        attempt=self.store.create_attempt(job['id'],attempt_id=aid,state='RUNNING',gpu_uuids=['GPU-0','GPU-1'],gpu_indices=[0,1],unit_name='gpuq-'+aid.lower(),unit_token='attempt:'+aid,boot_id='test-boot',invocation_id='a'*32,control_dir=str(control),log_path=str(log))
        self.store.update_attempt(aid,state='RUNNING')
        self.coordinator.clock=lambda:time.time()+1000
        self.store.acquire_leases(job['id'],aid,{'GPU-0':0,'GPU-1':1});self.store.update_job(job['id'],state='RUNNING')
        return self.store.get_job(job['id']),attempt

    def test_new_idle_cards_choose_legal_target_and_request_save_once_without_hot_attaching(self):
        job,attempt=self.running_elastic();self.snapshot(occupied=(3,));self.coordinator._schedule_scale_ups()
        self.assertEqual(self.store.list_scale_up_plans(),[],'2+1 free is illegal at global256/micro8')
        self.snapshot();self.coordinator._schedule_scale_ups();plan=self.store.get_active_scale_up_plan(job['id'])
        self.assertEqual((plan['from_gpu_count'],plan['target_gpu_count'],plan['state']),(2,4,'SAVE_REQUESTED'))
        self.assertEqual(self.store.get_attempt(attempt['id'])['gpu_indices'],[0,1],'old process keeps old world size until save and drain')
        self.assertEqual(len(self.store.list_leases()),2);self.assertEqual(len(self.store.list_scale_up_reservations()),2)
        self.assertEqual([a['action_type'] for a in self.store.list_actions()],['REQUEST_SAVE'])
        self.coordinator._schedule_scale_ups();self.assertEqual(len(self.store.list_actions()),1)

    def test_save_exit75_creates_a_new_four_card_attempt_with_original_checkpoint(self):
        job,attempt=self.running_elastic();self.coordinator._schedule_scale_ups()
        current=self.store.get_attempt(attempt['id']);ack={'checkpoint_path':str(self.root/'checkpoint.pt'),'exit_code':75}
        self.coordinator._record_checkpoint_ack(current,ack,expected_state=AttemptState.SAVE_REQUESTED)
        self.store.update_attempt(attempt['id'],state='DRAINING',exit_code=75)
        current=self.store.get_attempt(attempt['id']);plan=self.store.get_active_scale_up_plan(job['id'])
        self.coordinator._finalize_scale_attempt(current,self.store.get_job(job['id']),plan,ack)
        self.assertEqual(self.store.get_attempt(attempt['id'])['state'],'PREEMPTED');self.assertEqual(self.store.get_job(job['id'])['state'],'PENDING')
        self.assertEqual(self.store.list_leases(),[]);self.assertEqual(len(self.store.list_scale_up_reservations()),4)
        plan=self.store.get_active_scale_up_plan(job['id']);successor=self.coordinator._plan_scale_up_restart(self.store.get_job(job['id']),plan)
        self.assertNotEqual(successor['id'],attempt['id']);self.assertEqual(successor['gpu_indices'],[0,1,2,3])
        self.assertEqual(successor['resume_from_attempt_id'],attempt['id']);self.assertEqual(successor['launch_resume_checkpoint_path'],ack['checkpoint_path'])
        self.assertEqual(len(self.store.list_leases()),4);self.assertEqual(self.store.list_scale_up_reservations(),[])

    def test_pending_queue_has_priority_over_opportunistic_expansion(self):
        job,attempt=self.running_elastic();self.submit(priority=0);self.coordinator._schedule_scale_ups()
        self.assertIsNone(self.store.get_active_scale_up_plan(job['id']));self.assertEqual(self.store.get_attempt(attempt['id'])['state'],'RUNNING')

    def test_scale_receipt_is_bound_to_the_exact_submission_and_plan_and_has_no_side_effects(self):
        job,attempt=self.running_elastic();self.coordinator._schedule_scale_ups()
        plan=self.store.get_active_scale_up_plan(job['id'])
        before='\n'.join(self.store._get_connection().iterdump())
        with patch.object(self.coordinator,'_require_release_open',side_effect=AssertionError('mutation gate invoked')):
            receipt=self.coordinator.handle_api('scale_up_receipt',{'submit_key':job['submit_key'],'plan_id':plan['id']})
        self.assertEqual(receipt['plan_state'],'SAVE_REQUESTED')
        self.assertEqual((receipt['from_gpu_count'],receipt['target_gpu_count']),(2,4))
        self.assertEqual(receipt['source_attempt_id'],attempt['id'])
        self.assertEqual(receipt['plan_reserved_gpu_count'],2)
        self.assertEqual(receipt['job_leased_gpu_count'],2)
        self.assertNotIn('checkpoint_path',receipt);self.assertNotIn('argv',receipt)
        self.assertIsNone(self.store.get_scale_up_receipt('other-key',plan['id']))
        self.assertIsNone(self.store.get_scale_up_receipt(job['submit_key'],'other-plan'))
        self.assertEqual('\n'.join(self.store._get_connection().iterdump()),before)

    def test_terminal_failed_plan_can_still_have_successor_gpu_leases_so_is_not_refund_proof(self):
        self.test_save_exit75_creates_a_new_four_card_attempt_with_original_checkpoint()
        plan=self.store.list_scale_up_plans()[0];job=self.store.get_job(plan['job_id'])
        self.store.transition_scale_up_plan(plan['id'],'FAILED',from_states=['RESTART_PLANNED'])
        receipt=self.store.get_scale_up_receipt(job['submit_key'],plan['id'])
        self.assertEqual(receipt['plan_state'],'FAILED')
        self.assertEqual(receipt['plan_reserved_gpu_count'],0)
        self.assertEqual(receipt['job_leased_gpu_count'],4)
        self.assertEqual(receipt['successor_attempt_state'],'PLANNED')

    def test_completed_receipt_retains_lineage_and_expanded_leases(self):
        self.test_save_exit75_creates_a_new_four_card_attempt_with_original_checkpoint()
        plan=self.store.list_scale_up_plans()[0];job=self.store.get_job(plan['job_id'])
        self.store.update_attempt(plan['successor_attempt_id'],state='RUNNING')
        self.store.update_job(job['id'],state='RUNNING')
        self.coordinator._complete_scale_up_if_running(self.store.get_attempt(plan['successor_attempt_id']))
        receipt=self.coordinator.handle_api('scale_up_receipt',{'submit_key':job['submit_key'],'plan_id':plan['id']})
        self.assertEqual(receipt['plan_state'],'COMPLETED')
        self.assertEqual(receipt['successor_attempt_id'],plan['successor_attempt_id'])
        self.assertEqual(receipt['successor_attempt_state'],'RUNNING')
        self.assertEqual(receipt['job_leased_gpu_count'],4)

    def test_receipt_requires_exact_bounded_submission_and_plan_keys(self):
        for arguments in [{},{'submit_key':'key'},{'submit_key':'key','plan_id':''},
                          {'submit_key':'key','plan_id':1},{'submit_key':'key','plan_id':'x'*257},
                          {'submit_key':'key','plan_id':'plan','job_id':'other'}]:
            with self.subTest(arguments=arguments),self.assertRaises(ApiError) as error:
                self.coordinator.handle_api('scale_up_receipt',arguments)
            self.assertEqual(error.exception.code,'BAD_REQUEST')

    def test_external_grant_is_required_before_reserving_extra_scale_gpus(self):
        job,attempt=self.running_elastic();db=self.store._get_connection()
        db.execute("UPDATE jobs SET allocation_authority='external-v1' WHERE id=?",(job['id'],))
        db.execute('INSERT INTO allocation_grants VALUES(?,?,1,2)',(job['id'],'grant-scale'))
        with self.assertRaisesRegex(StoreConflictError,'does not cover'):
            self.coordinator._schedule_scale_ups()
        self.assertEqual(self.store.list_scale_up_plans(),[])
        self.assertEqual(self.store.list_scale_up_reservations(),[])
        self.assertEqual(len(self.store.list_leases()),2)
        self.assertEqual(self.store.list_actions(),[])
        db.execute('UPDATE allocation_grants SET max_gpu_count=4 WHERE job_id=?',(job['id'],))
        self.coordinator._schedule_scale_ups()
        plan=self.store.get_active_scale_up_plan(job['id'])
        self.assertEqual(plan['target_gpu_count'],4)
        self.assertEqual(len(self.store.list_scale_up_reservations()),2)
        db.execute('UPDATE allocation_grants SET max_gpu_count=0 WHERE job_id=?',(job['id'],))
        self.assertEqual(self.store.release_scale_up_reservations(plan['id']),2)

    def test_revoked_grant_prevents_reservation_to_lease_conversion_with_atomic_rollback(self):
        job,attempt=self.running_elastic();self.coordinator._schedule_scale_ups()
        current=self.store.get_attempt(attempt['id']);ack={'checkpoint_path':str(self.root/'checkpoint.pt'),'exit_code':75}
        self.coordinator._record_checkpoint_ack(current,ack,expected_state=AttemptState.SAVE_REQUESTED)
        self.store.update_attempt(attempt['id'],state='DRAINING',exit_code=75)
        self.coordinator._finalize_scale_attempt(self.store.get_attempt(attempt['id']),self.store.get_job(job['id']),
                                               self.store.get_active_scale_up_plan(job['id']),ack)
        plan=self.store.get_active_scale_up_plan(job['id']);db=self.store._get_connection()
        db.execute("UPDATE jobs SET allocation_authority='external-v1' WHERE id=?",(job['id'],))
        db.execute('INSERT INTO allocation_grants VALUES(?,?,1,2)',(job['id'],'grant-scale'))
        before='\n'.join(db.iterdump())
        with self.assertRaisesRegex(StoreConflictError,'does not cover'):
            self.store.reserve_full_scale_up_target(plan['id'])
        self.assertEqual('\n'.join(db.iterdump()),before)
        with self.assertRaisesRegex(StoreConflictError,'does not cover'):
            self.coordinator._plan_scale_up_restart(self.store.get_job(job['id']),plan)
        self.assertEqual('\n'.join(db.iterdump()),before)
        self.assertEqual(len(self.store.list_scale_up_reservations()),4)
        self.assertEqual(self.store.list_leases(),[])

if __name__=='__main__':unittest.main()
