// MODULE: brain-vault-writers.test.ts - Actual kernel leases catch descriptors hidden from /proc
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {it,expect} from 'vitest'
it('proves released files and refuses held descriptors, writable mappings and a nondumpable writer',()=>{
 const script=join(import.meta.dirname,'../../bin/brain-vault-writers.py')
 const result=spawnSync('/usr/bin/python3',['-I','-c',`
import importlib.util,tempfile,pathlib,os,mmap,subprocess,sys
spec=importlib.util.spec_from_file_location('probe',sys.argv[1]);probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
with tempfile.TemporaryDirectory(prefix='bmn-126-lease-test-') as root:
 path=pathlib.Path(root)/'synthetic.md';path.write_bytes(b'synthetic\\n')
 assert probe.lease_proof(root)['proved']
 fd=os.open(path,os.O_RDWR)
 assert not probe.lease_proof(root)['proved']
 mapping=mmap.mmap(fd,0,access=mmap.ACCESS_WRITE);os.close(fd)
 assert not probe.lease_proof(root)['proved']
 mapping.close();assert probe.lease_proof(root)['proved']
 child=subprocess.Popen(['/usr/bin/python3','-I','-c',"import os,sys,ctypes;f=os.open(sys.argv[1],os.O_RDWR);ctypes.CDLL(None).prctl(4,0);print('READY',flush=True);sys.stdin.readline();os.close(f)",str(path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
 try:
  assert child.stdout.readline().strip()=='READY'
  assert not probe.lease_proof(root)['proved']
 finally:
  child.communicate('release\\n',timeout=5)
 assert probe.check(root)['unknown']==[]
 print('PASS kernel leases, mappings, nondumpable writer, release and hidden-process controls')
`,script],{encoding:'utf8',timeout:15_000})
 expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('PASS kernel leases')
})
