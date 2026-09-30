#!/usr/bin/python3
"""Local Unix socket -> fixed SSH forced commands. No public listener or shell."""
import json, os, socketserver, subprocess
from pathlib import Path
BASE=Path('/opt/gpuq-console/executor')
HOSTS={n['id']:n for n in json.loads(Path('/opt/gpuq-console/inventory.json').read_text())['nodes']}
OPERATIONS={'offer','admit','cancel-admission','sync','cancel','logs','diagnostics','watch','priority'}
for prefix,actions in {
    'host':('exec','status','cancel'),
    'files':('list','put','get'),
    'terminal':('open','exchange','close','detach'),
    'datasets':('list','status','prepare','register','unregister'),
    'datasets.upload':('begin','manifest','seal','status','chunk','commit','discard'),
    'datasets.workspace':('list','put','get','status','publish'),
    'projects':('list','create','status','publish','verify'),
    'projects.snapshot':('info','manifest','get'),
    'datasets.snapshot':('info','manifest','get'),
    'projects.sync':('begin','manifest','seal','status','chunk','finish'),
}.items():OPERATIONS.update(prefix+'.'+action for action in actions)
class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(35)
        try:
            data=json.loads(self.rfile.readline(1600001))
            if data['machine'] not in HOSTS or data['operation'] not in OPERATIONS: raise ValueError('Invalid operation')
            host=HOSTS[data['machine']]
            p=subprocess.run(['/usr/bin/ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','ConnectTimeout=5','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o',f'UserKnownHostsFile={BASE}/known_hosts','-i',str(BASE/'id_ed25519'),host['user']+'@'+host['address']],input=json.dumps({'operation':data['operation'],'args':data['args']}),text=True,capture_output=True,timeout=27)
            if p.returncode: raise ValueError('Node connection failed')
            result=json.loads(p.stdout)
        except Exception as e: result={'ok':False,'error':str(e)[:200]}
        self.wfile.write((json.dumps(result)+'\n').encode())
class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads=True
if __name__=='__main__':
    os.umask(0o007)
    sock='/run/gpuq-console-executor/bridge.sock'
    if os.path.exists(sock):os.unlink(sock)
    with Server(sock,Handler) as server:
        os.chmod(sock,0o660);os.chown(sock,0,1000);server.serve_forever()
