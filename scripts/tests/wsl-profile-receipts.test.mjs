// Shared receipt logic under simulated platform guards; no WSL/root process runs.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureRestrictedGuestProfile, measureRootRestrictedGuestProfile, measureNestedGuestNamespaces } from '../test/wsl-restricted-profile-spike.mjs'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const distribution = 'BMN-Epic53-Systemd-00000000-0000-0000-0000-000000000000'
it('builds all kernel candidates from a Windows CRLF checkout without executing them', () => {
  const fixture = readFileSync(new URL('../test/fixtures/wsl-nested-capability.py', import.meta.url), 'utf8')
  const helper = readFileSync(new URL('../lib/wsl-root-session.py', import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n')
  const script = `import ast,json,sys
packet=json.load(sys.stdin)
tree=ast.parse(packet['fixture'])
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='candidate_source')
scope={};exec(compile(ast.Module(body=[function],type_ignores=[]),'candidate-source-only','exec'),scope)
for nested,pivot in [(False,False),(True,False),(False,True),(True,True)]:
 source=scope['candidate_source'](packet['helper'],nested,pivot)
 ast.parse(source)
 assert ('os.chroot(directory)' not in source)==pivot
 assert ('blocked = [n for n in blocked if' in source)==nested
print('FOUR_CANDIDATES_OK')`
  Object.defineProperty(process, 'platform', platform)
  try {
    expect(execFileSync(platform.value === 'win32' ? 'python' : 'python3', ['-c', script], {
      input: JSON.stringify({ fixture, helper }), encoding: 'utf8', timeout: 5000
    }).trim()).toBe('FOUR_CANDIDATES_OK')
  } finally { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }) }
})
it('keeps cgroup/time namespaces and parent/ptrace clone flags denied in the nested candidate bytecode', () => {
  const fixture = readFileSync(new URL('../test/fixtures/wsl-nested-capability.py', import.meta.url), 'utf8')
  const helper = readFileSync(new URL('../lib/wsl-root-session.py', import.meta.url), 'utf8')
  const script = `import ast,json,sys,errno
packet=json.load(sys.stdin);tree=ast.parse(packet['fixture'])
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='candidate_source')
factory={};exec(compile(ast.Module(body=[function],type_ignores=[]),'candidate-source','exec'),factory)
scope={};exec(compile(factory['candidate_source'](packet['helper'],True,True),'candidate-helper','exec'),scope)
class Capture:
 def prctl(self,*args):
  if args[0]==22:
   program=args[2]._obj
   self.ops=[(program.filter[i].code,program.filter[i].jt,program.filter[i].jf,program.filter[i].k) for i in range(program.length)]
  return 0
capture=Capture();scope['LIBC']=capture;scope['restrict_syscalls']()
def decide(number,flags):
 offset=0;value=0
 while True:
  op,yes,no,k=capture.ops[offset];offset+=1
  if op==0x20:value={0:number,4:0xc000003e,16:flags}[k]
  elif op==0x15:offset+=yes if value==k else no
  elif op==0x35:offset+=yes if value>=k else no
  elif op==0x45:offset+=yes if value&k else no
  elif op==0x06:return k
  else:raise AssertionError(op)
denied=0x50000|errno.EPERM;allow=0x7fff0000
for number,flags in [(56,0x8000),(56,0x2000),(56,0x2000000),(272,0x2000000),(272,0x80)]:
 assert decide(number,flags)==denied,(number,flags,decide(number,flags))
for number,flags in [(56,17),(56,0x10000000|0x20000|17),(272,0x10000000|0x20000)]:
 assert decide(number,flags)==allow,(number,flags,decide(number,flags))
assert decide(308,0)==denied
assert decide(435,0)==0x50000|errno.ENOSYS
print('NESTED_FILTER_FLAGS_OK')`
  Object.defineProperty(process, 'platform', platform)
  try {
    expect(execFileSync(platform.value === 'win32' ? 'python' : 'python3', ['-c', script], {
      input: JSON.stringify({ fixture, helper }), encoding: 'utf8', timeout: 5000
    }).trim()).toBe('NESTED_FILTER_FLAGS_OK')
  } finally { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }) }
})
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  vi.stubEnv('GITHUB_ACTIONS', 'true')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})
const rows = count => Array.from({ length: count }, () => ({ retainedPidfds: 3, allExited: true,
  peer: { procAliasDenied: true }, outsideActorsCreated: 0, unrelatedSentinelsAlive: true,
  outsideBrokersDenied: [{}, {}, {}] }))
const routes = [
  ['ordinary profile', measureRestrictedGuestProfile, () => ({ socketBroker: [{ survivedCallerExit: true }, { deniedErrno: 1 }],
    lifecycle: rows(3), profileComplete: false })],
  ['root profile', measureRootRestrictedGuestProfile, () => ({ outsideBrokerPositiveControls: 4,
    i386PositiveControl: true, i386AndX32Denied: true, lifecycle: [...rows(4),
      { ...rows(1)[0], mode: 'nonreading-stdin-eof' },
      { ...rows(1)[0], mode: 'nonreading-tty-eof', rawPtySixelBytesPreserved: true }], syntheticFilesRemoved: true,
    callbackFailure: { exit: 70, callerCleanupUnwound: false }, uidLeases: { workerThreadFsUidNotReused: true }, syslogSizeProbe: { contentsRead: false, filteredPolicyErrno: 13 }, profileComplete: false })]
]
describe.each(routes)('%s receipt gate', (_name, measure, valid) => {
  it('returns FAIL for malformed zero-exit output so the outer native gate cannot lose the failure', () => {
    expect(measure({ distribution, uid: 1000, guest: () => ({ exit: 0, stdout: 'not-json' }) }))
      .toMatchObject({ result: 'FAIL', receiptValidationFailed: true, profileComplete: false })
  })
  it.each(['throw', 'undefined'])('normalizes a guest %s into a durable FAIL receipt', mode => {
    const guest = mode === 'throw' ? () => { throw new Error('synthetic guest failure') } : () => undefined
    expect(measure({ distribution, uid: 1000, guest }))
      .toMatchObject({ result: 'FAIL', receiptValidationFailed: true, profileComplete: false })
  })
  it('returns FAIL when a zero-exit receipt reports a surviving owned process', () => {
    const receipt = valid(); receipt.lifecycle[0].allExited = false
    expect(measure({ distribution, uid: 1000, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject({ result: 'FAIL', receiptValidationFailed: true, profileComplete: false })
  })
  it('sends syntactically valid Python to the guest', () => {
    const receipt = valid(), scripts = []
    const guest = args => {
      if (args[0].endsWith('python3')) scripts.push(args[2])
      return { exit: 0, stdout: JSON.stringify(receipt) }
    }
    expect(measure({ distribution, uid: 1000, guest })).toMatchObject(receipt)
    // Parse outside the guest's fail-normalization boundary, after restoring
    // the actual host platform for Node's child-process implementation.
    Object.defineProperty(process, 'platform', platform)
    try {
      for (const source of scripts) execFileSync(platform.value === 'win32' ? 'python' : 'python3',
        ['-c', 'import ast,sys; ast.parse(sys.argv[1])', source], { encoding: 'utf8', timeout: 5000 })
    } finally { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }) }
  })
  it('retains a valid scoped measurement with profileComplete false', () => {
    const receipt = valid()
    expect(measure({ distribution, uid: 1000, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject(receipt)
  })
})

it.each([4, 5])('refuses a root receipt with only %i lifecycle measurements', count => {
  const receipt = routes[1][2]()
  receipt.lifecycle = receipt.lifecycle.slice(0, count)
  expect(measureRootRestrictedGuestProfile({ distribution, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
    .toMatchObject({ result: 'FAIL', receiptValidationFailed: true, profileComplete: false })
})

function nestedReceipt() {
  return { profileComplete: false, sandbox: { status: 'PASS_REAL_BWRAP_ONLY', exit: 0, version: 'bubblewrap 0.8.0',
    profileComplete: false, proof: { nestedUid: 0, singleUidMap: true, noNewPrivileges: true, capabilitiesDropped: true,
      outsideUidMapDenied: true, outsideSyscallsDenied: true, outsideBrokerDenied: true, privateWorkspaceWrite: true, oldRootDetached: true } },
  rows: [[false, false], [true, false], [false, true], [true, true]].map(([amendedFilter, pivotRoot]) => ({
    amendedFilter, pivotRoot, outsideBrokerPositiveControl: true,
    ...(amendedFilter && pivotRoot ? { status: 'PASS_KERNEL_PROBE_ONLY', outsideUidMapDenied: true,
      privateMountWrite: true, outsideSyscallsDenied: true, outsideBrokerDenied: true,
      noNewPrivileges: true, oldRootDetached: true, readOnlyRemountDenied: 1 }
      : { status: 'UNAVAILABLE', errno: 1 })
  })) }
}

describe('nested kernel discriminator receipts', () => {
  it('refuses a kernel-only receipt without actual nested sandbox execution', () => {
    const receipt = nestedReceipt(); delete receipt.sandbox
    expect(measureNestedGuestNamespaces({ distribution, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject({ result: 'FAIL', profileComplete: false })
  })
  it('keeps a valid four-cell kernel measurement separate from full profile acceptance', () => {
    const receipt = nestedReceipt()
    expect(measureNestedGuestNamespaces({ distribution, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject({ ...receipt, wsl2: 'PASS_KERNEL_AND_REAL_BWRAP_ONLY' })
  })
  it.each(['failed-process', 'nonzero-exit', 'no-single-uid', 'broker-reachable', 'capabilities-retained', 'full-profile-claim'])('refuses a sandbox %s', defect => {
    const receipt = nestedReceipt(), sandbox = receipt.sandbox
    if (defect === 'failed-process') sandbox.status = 'FAIL'
    if (defect === 'nonzero-exit') sandbox.exit = 1
    if (defect === 'no-single-uid') sandbox.proof.singleUidMap = false
    if (defect === 'broker-reachable') sandbox.proof.outsideBrokerDenied = false
    if (defect === 'capabilities-retained') sandbox.proof.capabilitiesDropped = false
    if (defect === 'full-profile-claim') sandbox.profileComplete = true
    expect(measureNestedGuestNamespaces({ distribution, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject({ result: 'FAIL', profileComplete: false })
  })
  it.each(['duplicate-cell', 'no-kernel-positive', 'broker-control-refused', 'old-root-retained', 'multi-uid-allowed', 'writable-tool-mount', 'full-profile-claim'])('refuses %s', defect => {
    const receipt = nestedReceipt(), positive = receipt.rows[3]
    if (defect === 'duplicate-cell') receipt.rows[3] = receipt.rows[0]
    if (defect === 'no-kernel-positive') positive.status = 'UNAVAILABLE'
    if (defect === 'broker-control-refused') positive.outsideBrokerPositiveControl = false
    if (defect === 'old-root-retained') positive.oldRootDetached = false
    if (defect === 'multi-uid-allowed') positive.outsideUidMapDenied = false
    if (defect === 'writable-tool-mount') positive.readOnlyRemountDenied = 0
    if (defect === 'full-profile-claim') receipt.profileComplete = true
    expect(measureNestedGuestNamespaces({ distribution, guest: () => ({ exit: 0, stdout: JSON.stringify(receipt) }) }))
      .toMatchObject({ result: 'FAIL', profileComplete: false })
  })
  it('does not accept missing or malformed output from a zero-exit guest', () => {
    for (const guest of [() => undefined, () => ({ exit: 0, stdout: '{}' }), () => { throw new Error('synthetic guest failure') }]) {
      expect(measureNestedGuestNamespaces({ distribution, guest })).toMatchObject({ result: 'FAIL', profileComplete: false })
    }
  })
})
