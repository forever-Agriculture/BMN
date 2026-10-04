// Measurement of the owner-approved restricted capability boundary, not a WSL adapter.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export function measureRestrictedGuestProfile({ distribution, uid, guest }) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.match(distribution, /^BMN-Epic53-Systemd-[0-9a-f-]+$/)
  assert.match(String(uid), /^\d+$/)
  // Install prerequisites only in the freshly imported synthetic distribution.
  // Never alter an owner's distro, namespace policy or authentication profiles.
  try {
    const prerequisites = guest(['/bin/sh', '-c', 'command -v bwrap || (apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -y -qq --no-install-recommends install bubblewrap)'], { timeout: 180000 })
    if (prerequisites.exit !== 0) return { result: 'INCONCLUSIVE', prerequisiteExit: prerequisites.exit, profileComplete: false }
    const source = readFileSync(new URL('./fixtures/wsl-restricted-profile.py', import.meta.url), 'utf8')
    const result = guest(['/usr/bin/python3', '-c', `import os,pathlib,subprocess,sys,tempfile,shutil,json
root=pathlib.Path(tempfile.mkdtemp(prefix='bmn-restricted-runner-'))
try:
 os.chmod(root,0o755);script=root/'probe.py';script.write_text(sys.stdin.read());os.chmod(script,0o444)
 run=subprocess.run(['runuser','-u','bmnfixture','--','env','-i','PATH=/usr/bin:/bin','BMN_SYNTHETIC_PLATFORM=native-wsl2','/usr/bin/python3',str(script)],capture_output=True,text=True,timeout=65,cwd='/')
 if run.returncode!=0:print(json.dumps({'result':'FAIL','exit':run.returncode,'stderr':run.stderr[:4000],'profileComplete':False}));sys.exit(1)
 receipt=json.loads(run.stdout);receipt['uid']=${uid};receipt['kernel']=os.uname().release
 print(json.dumps(receipt))
finally:shutil.rmtree(root)

`], { input: source, timeout: 80000 })
    if (result.exit !== 0) return { result: 'FAIL', exit: result.exit, stderr: result.stderr ?? '', detail: result.stdout, profileComplete: false }
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.socketBroker[0].survivedCallerExit, true, 'The outside broker must be ready and reproduce the baseline escape')
    assert.equal(receipt.socketBroker[1].deniedErrno, 1)
    assert.equal(receipt.lifecycle.length, 3)
    assert.ok(receipt.lifecycle.every(row => row.retainedPidfds === 3 && row.allExited))
    assert.equal(receipt.profileComplete, false, 'This spike does not establish provider, durable project or GUI parity')
    return receipt
  } catch {
    // A validation throw must remain a FAIL receipt for the outer CI gate.
    return { result: 'FAIL', receiptValidationFailed: true, profileComplete: false }
  }
}

// Root is confined to this newly imported synthetic registration. This invokes
// the approved per-session design measurement, never an owner's distribution.
export function measureRootRestrictedGuestProfile({ distribution, guest }) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.match(distribution, /^BMN-Epic53-Systemd-[0-9a-f-]+$/)
  try {
    const source = readFileSync(new URL('./fixtures/wsl-root-profile.py', import.meta.url), 'utf8')
    const helper = readFileSync(new URL('../lib/wsl-root-session.py', import.meta.url), 'utf8')
    const result = guest(['/usr/bin/python3', '-c', 'import sys,json,types; p=json.loads(sys.stdin.read()); m=types.ModuleType("bmn_root_session"); exec(compile(p["helper"],"bmn-root-helper.py","exec"),m.__dict__); sys.modules[m.__name__]=m; exec(compile(p["fixture"],"bmn-root-profile.py","exec"))'], {
      input: JSON.stringify({ helper, fixture: source }), timeout: 85000
    })
    if (result.exit !== 0) return { result: 'FAIL', exit: result.exit, stderr: result.stderr ?? '', detail: result.stdout, profileComplete: false }
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.outsideBrokerPositiveControls, 4, 'Every outside broker must be ready and capable of launching')
    assert.equal(receipt.i386PositiveControl, true)
    assert.equal(receipt.i386AndX32Denied, true)
    assert.equal(receipt.lifecycle.length, 4)
    assert.ok(receipt.lifecycle.every(row => row.retainedPidfds === 3 && row.allExited && row.peer.procAliasDenied &&
      row.outsideActorsCreated === 0 && row.unrelatedSentinelsAlive && row.outsideBrokersDenied.length === 3))
    assert.equal(receipt.syntheticFilesRemoved, true)
    assert.equal(receipt.uidLeases.workerThreadFsUidNotReused, true)
    assert.equal(receipt.callbackFailure.exit, 70)
    assert.equal(receipt.callbackFailure.callerCleanupUnwound, false)
    assert.equal(receipt.syslogSizeProbe.contentsRead, false)
    assert.equal(receipt.syslogSizeProbe.filteredPolicyErrno, 13)
    assert.equal(receipt.profileComplete, false)
    return { ...receipt, wsl2: 'PASS_MEASURED_ROOT_PROFILE_ONLY' }
  } catch {
    // A validation throw must remain a FAIL receipt for the outer CI gate.
    return { result: 'FAIL', receiptValidationFailed: true, profileComplete: false }
  }
}
