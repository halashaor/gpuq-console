"""Forced command fleet read-only offer, ambiguous receipt and cancel drain."""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(__file__).resolve().parents[1]

class NodeAdmission(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        for name in ('node-executor.py','scheduling-policy.py'):shutil.copy2(ROOT/'deploy'/name,self.root/name)
        config={'root':str(self.root/'state'),'cards':8,'gpu':'/not/a/gpu','database':str(self.root/'db')};(self.root/'node-config.json').write_text(json.dumps(config))
        (Path(config['root'])/'jobs').mkdir(parents=True)
        with closing(sqlite3.connect(config['database'])) as db:db.execute('CREATE TABLE jobs(id TEXT,submit_key TEXT)');db.commit()
        spec=importlib.util.spec_from_file_location('fleet_node_test',self.root/'node-executor.py');self.node=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.node)
        self.job={'id':str(uuid.uuid4()),'userId':'demo-user-1','username':'alice','cards':1,'argv':['python','train.py'],'name':'test','minVramGiB':0,'priority':'normal','preemptIdleOnly':True}
        self.args={'job':self.job,'admissionKey':str(uuid.uuid4()),'allowPreempt':False};self.commands=[];self.accepted=False;self.timeout=False;self.cancel=False;self.leases=[]
        def run(command,**_):
            args=command[2:];self.commands.append(args)
            if args[0]=='status':return json.dumps({'daemon':{'capabilities':['priority-policy-v1','preempt-idle-only-v1','fleet-admission-v2']}})
            if args[0]=='submit':
                if '--offer-only' in args:return json.dumps({'kind':'idle','count':1})
                if self.timeout:raise TimeoutError('uncertain SSH response')
                if '--cancel-admission' in args:self.cancel=True
                if not self.accepted:return json.dumps({'accepted':False,'canceled':self.cancel,'reason':'canceled' if self.cancel else 'busy'})
                return json.dumps({'accepted':True,'job_id':'Jabc'})
            if args[0]=='show':return json.dumps({'job':{'state':'CANCELED' if self.cancel else 'RUNNING'},'attempts':[],'leases':self.leases})
            raise AssertionError(args)
        mock=patch.object(self.node,'run',side_effect=run);mock.start();self.addCleanup(mock.stop)

    def test_offer_does_not_create_workspace_job_spec_or_receipt(self):
        before=sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*'))
        with patch.object(self.node,'workspace',side_effect=AssertionError('offer created workspace')):
            self.assertEqual(self.node.process('offer',{'job':self.job,'allowPreempt':False}),{'kind':'idle','count':1})
        self.assertEqual(sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')),before)
        submitted=next(c for c in self.commands if c[0]=='submit');self.assertIn('--offer-only',submitted);self.assertNotIn('--admission-preempt',submitted)
        self.assertEqual(submitted[submitted.index('--cwd')+1],str(self.node.ROOT/'jobs'))
        self.assertIn('GPU_SYNC_INPUT_PATHS=',submitted[submitted.index('--env')+1])

    def test_ambiguous_admit_cannot_change_token_and_does_not_release_dataset_leases(self):
        self.timeout=True
        with patch.object(self.node,'release_datasets') as release:
            with self.assertRaises(TimeoutError):self.node.process('admit',self.args)
            release.assert_not_called()
            with self.assertRaisesRegex(ValueError,'original token'):self.node.process('admit',{**self.args,'admissionKey':str(uuid.uuid4())})

    def test_cancel_tombstone_turns_late_node_admit_into_same_token_cancellation(self):
        result=self.node.process('cancel-admission',self.args);self.assertFalse(result['accepted']);self.assertEqual(result['state'],'CANCELED')
        self.node.process('admit',self.args)
        submits=[c for c in self.commands if c[0]=='submit'];self.assertEqual(len(submits),2)
        for args in submits:self.assertIn('--cancel-admission',args);self.assertEqual(args[args.index('--admission-token')+1],self.args['admissionKey'])

    def test_accepted_cancel_retains_unknown_until_native_leases_drain(self):
        self.accepted=True;self.leases=[{'attempt_id':'A1','gpu_uuid':'GPU-0'}]
        result=self.node.process('cancel-admission',self.args);self.assertTrue(result['accepted']);self.assertEqual(result['state'],'UNKNOWN')
        self.leases=[];result=self.node.process('cancel-admission',self.args);self.assertEqual(result['state'],'CANCELED')

if __name__=='__main__':unittest.main()
