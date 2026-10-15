import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'vitest'
import {
  findSandboxDisablingText,
  scanForSandboxDisablingFlags
} from '../lib/sandbox-flag-audit.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bypassOption = ['--', 'no', '-sandbox'].join('')
const sandboxKey = ['sand', 'box'].join('')
const chromiumSandboxKey = ['chromium', 'Sandbox'].join('')
const disabledWord = ['fal', 'se'].join('')

async function temporaryRepo() {
  const root = await mkdtemp(join(tmpdir(), 'bmn-sandbox-audit-'))
  await mkdir(join(root, 'apps'), { recursive: true })
  return root
}

describe('sandbox flag repository audit', () => {
  for (const [label, source] of [
    ['dashed bypass option', bypassOption],
    ['appendSwitch bypass option', `appendSwitch('${['no', 'sandbox'].join('-')}')`],
    ['dashed wildcard option', ['--disable-', 'setuid-', 'sandbox'].join('')],
    ['appendSwitch wildcard option', `appendSwitch('${['disable', 'seccomp-filter', 'sandbox'].join('-')}')`],
    ['environment variable', ['ELECTRON', 'DISABLE', 'SANDBOX'].join('_')],
    ['chromiumSandbox colon', `${chromiumSandboxKey}: ${disabledWord}`],
    ['quoted chromiumSandbox', `"${chromiumSandboxKey}": ${disabledWord}`],
    ['snake-case chromium sandbox', `${['chromium', '_sandbox'].join('')}: ${disabledWord}`],
    ['quoted kebab-case chromium sandbox and value', `'${['chromium', '-sandbox'].join('')}': '${disabledWord}'`],
    ['sandbox equals', `${sandboxKey} = ${disabledWord}`],
    ['quoted sandbox and value', `"${sandboxKey}": "${disabledWord}"`],
    ['numeric zero', `${sandboxKey}: 0`],
    ['hexadecimal zero', `${sandboxKey}: 0x0`],
    ['decimal zero', `${sandboxKey}: -0.0`],
    ['trailing-point zero', `${sandboxKey}: 0.`],
    ['leading-point zero', `${sandboxKey}: .0`],
    ['exponent zero', `${sandboxKey}: 0e42`],
    ['binary zero', `${sandboxKey}: 0b0`],
    ['octal zero', `${sandboxKey}: 0o0`],
    ['bigint zero', `${sandboxKey}: 0n`],
    ['null', `${sandboxKey}: null`],
    ['undefined', `${sandboxKey}: undefined`],
    ['not-a-number', `${sandboxKey}: NaN`],
    ['empty double-quoted string', `${sandboxKey}: ""`],
    ['empty single-quoted string', `${sandboxKey}: ''`],
    ['negated one', `${sandboxKey}: !1`],
    ['YAML off', `${sandboxKey}: off`],
    ['YAML no', `${sandboxKey}: no`],
    ['highest-value chromium zero', `${chromiumSandboxKey}: 0`],
    ['quoted chromium zero', `"${chromiumSandboxKey}": 0`]
  ]) {
    it(`detects ${label}`, () => {
      assert.notDeepEqual(findSandboxDisablingText(source), [])
    })
  }

  for (const source of [
    `${sandboxKey}: true`,
    `${sandboxKey}: 1`,
    `${sandboxKey}: ${disabledWord}y`,
    '"falsehood"',
    `use${['Sand', 'box'].join('')}: ${disabledWord}`,
    `${sandboxKey}Enabled: ${disabledWord}`,
    `${sandboxKey}Count: 0`,
    ['--disable-features=', 'sandbox'].join(''),
    '--disable-gpu',
    `const ${sandboxKey} = createSandbox()`,
    `${sandboxKey}: 0 || cfg.flag`,
    `${sandboxKey}: isEnabled`,
    `${sandboxKey}: cfg.flag`
  ]) {
    it(`does not reject non-disabling input ${JSON.stringify(source)}`, () => {
      assert.deepEqual(findSandboxDisablingText(source), [])
    })
  }

  it('scans executable and environment files without treating prose as configuration', async () => {
    const root = await temporaryRepo()
    try {
      await Promise.all([
        writeFile(join(root, 'apps', 'launcher.sh'), `#!/bin/sh\necho '${bypassOption}'\n`),
        writeFile(join(root, 'apps', 'launcher.bash'), `echo '${bypassOption}'\n`),
        writeFile(join(root, 'apps', 'launcher.zsh'), `echo '${bypassOption}'\n`),
        writeFile(join(root, 'apps', '.env'), `LAUNCH_ARGS=${bypassOption}\n`),
        writeFile(join(root, 'apps', 'launcher'), `#!/bin/sh\necho '${bypassOption}'\n`),
        writeFile(join(root, 'apps', 'review.md'), `The forbidden example is ${bypassOption}.\n`),
        writeFile(join(root, 'apps', 'README'), `The forbidden example is ${bypassOption}.\n`)
      ])
      const findings = await scanForSandboxDisablingFlags(root)
      findings.sort((left, right) => left.file.localeCompare(right.file))
      assert.deepEqual(findings, [
        { file: 'apps/.env', rule: 'sandbox bypass command-line option' },
        { file: 'apps/launcher', rule: 'sandbox bypass command-line option' },
        { file: 'apps/launcher.bash', rule: 'sandbox bypass command-line option' },
        { file: 'apps/launcher.sh', rule: 'sandbox bypass command-line option' },
        { file: 'apps/launcher.zsh', rule: 'sandbox bypass command-line option' }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns normally when root manifests are absent', async () => {
    const root = await temporaryRepo()
    try {
      assert.deepEqual(await scanForSandboxDisablingFlags(root), [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds no sandbox-disabling configuration in product and test sources', async () => {
    assert.deepEqual(await scanForSandboxDisablingFlags(repoRoot), [])
  })
})
