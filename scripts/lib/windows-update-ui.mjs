// MODULE: windows-update-ui.mjs - owned WinForms progress, failure and log windows for the Windows desktop start
// Fixed scripts run on the absolute system PowerShell in STA without a profile;
// text arrives as environment data, never as script. Each window reports its
// decisions as exclusively created event files in its private directory,
// because an exit status cannot tell dismissal, crash and requested closure apart.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ensurePrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'
import { WindowsUpdateDecisionLatch } from './windows-update-decisions.mjs'

export const WINDOWS_APP_ID = 'dev.bmn.desktop'
const prelude = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$directory=$env:BMN_UPDATE_UI_DIRECTORY
$script:sequence=0
function Write-Decision([string]$action) {
  try {
    $script:sequence++
    $name=[string]::Format('{0}-{1}.event',$script:sequence,$action)
    $stream=[IO.File]::Open([IO.Path]::Combine($directory,$name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $stream.Dispose()
  } catch { [Environment]::Exit(4) }
}
function New-Window([string]$title,[int]$width,[int]$height) {
  $form=New-Object Windows.Forms.Form
  $form.Text=$title; $form.FormBorderStyle=[Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox=$false; $form.MinimizeBox=$false; $form.ShowInTaskbar=$true
  $form.StartPosition=[Windows.Forms.FormStartPosition]::CenterScreen
  $form.ClientSize=New-Object Drawing.Size($width,$height)
  return $form
}
function New-Button([string]$text,[int]$x,[int]$y) {
  $button=New-Object Windows.Forms.Button; $button.Text=$text; $button.SetBounds($x,$y,110,30); return $button
}
`
// Progress is informational: nothing it offers stops the update, and closing it
// any way other than the parent's completion request suppresses opening BMN.
const progressScript = prelude + `Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))
function Read-Progress {
  try {
    $stream=[IO.File]::Open($env:BMN_UPDATE_PROGRESS,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'ReadWrite, Delete')
    try {
      if ($stream.Length -gt 65536) { return $null }
      $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8); $value=$reader.ReadToEnd() | ConvertFrom-Json
    } finally { $stream.Dispose() }
    if ($value.attemptId -ceq $env:BMN_UPDATE_ATTEMPT -and $value.text -is [string] -and $value.text.Length -le 200) { return $value.text }
  } catch {}
  return $null
}
$form=New-Window 'BMN is updating' 400 124
$label=New-Object Windows.Forms.Label; $label.AutoSize=$false; $label.UseMnemonic=$false; $label.SetBounds(16,14,368,36); $label.Text=$env:BMN_UPDATE_TEXT
$bar=New-Object Windows.Forms.ProgressBar; $bar.Style=[Windows.Forms.ProgressBarStyle]::Marquee; $bar.MarqueeAnimationSpeed=30; $bar.SetBounds(16,52,368,16)
$wait=New-Button "Don't wait" 274 82
$form.Controls.AddRange(@($label,$bar,$wait)); $form.CancelButton=$wait
$script:requested=$false
$wait.Add_Click({ $form.Close() })
$form.Add_FormClosing({ if (-not $script:requested) { Write-Decision 'dismissed' } })
$timer=New-Object Windows.Forms.Timer; $timer.Interval=250
$timer.Add_Tick({
  $text=Read-Progress
  if ($text -and $label.Text -cne $text) { $label.Text=$text }
  if ([IO.File]::Exists([IO.Path]::Combine($directory,'close.request'))) { $timer.Stop(); $script:requested=$true; Write-Decision 'completion-closed'; $form.Close() }
})
$form.Add_Shown({ Write-Decision 'ready'; $timer.Start(); $form.Activate() })
[void]$form.ShowDialog()
`
const buttonSets = new Map([['open-log', [['Open BMN', 'open'], ['Show log', 'show-log']]],
  ['log-close', [['Show log', 'show-log'], ['Close', 'closed']]], ['close', [['Close', 'closed']]]])
const questionScript = prelude + `$form=New-Window $env:BMN_UPDATE_TITLE 400 132
$label=New-Object Windows.Forms.Label; $label.AutoSize=$false; $label.UseMnemonic=$false; $label.SetBounds(16,14,368,64); $label.Text=$env:BMN_UPDATE_TEXT
$form.Controls.Add($label)
$script:decided=$false
$labels=@($env:BMN_UPDATE_BUTTON_LABELS -split [char]10); $actions=@($env:BMN_UPDATE_BUTTON_ACTIONS -split [char]10)
for ($index=0; $index -lt $labels.Count; $index++) {
  $button=New-Button $labels[$index] (274-($labels.Count-1-$index)*118) 90
  $button.Tag=$actions[$index]
  $button.Add_Click({ $script:decided=$true; Write-Decision ([string]$this.Tag); $form.Close() })
  $form.Controls.Add($button)
  if ($index -eq 0) { $form.AcceptButton=$button }
}
$form.Add_FormClosing({ if (-not $script:decided) { Write-Decision 'closed' } })
$form.Add_Shown({ Write-Decision 'ready'; $form.Activate() })
[void]$form.ShowDialog()
`
const logScript = prelude + `$form=New-Window 'BMN update log' 640 380
$box=New-Object Windows.Forms.TextBox; $box.Multiline=$true; $box.ReadOnly=$true; $box.ScrollBars=[Windows.Forms.ScrollBars]::Vertical
$box.Font=New-Object Drawing.Font('Consolas',9); $box.SetBounds(12,12,616,316)
$box.Text=[IO.File]::ReadAllText([IO.Path]::Combine($directory,'log.txt'),[Text.Encoding]::UTF8)
$close=New-Button 'Close' 518 340
$close.Add_Click({ $form.Close() })
$form.Controls.AddRange(@($box,$close)); $form.CancelButton=$close; $form.AcceptButton=$close
$form.Add_FormClosing({ Write-Decision 'closed' })
$form.Add_Shown({ Write-Decision 'ready'; $close.Focus() })
[void]$form.ShowDialog()
`
// Informational only: no activation action can launch a payload. Submission is
// not proof that Windows displayed it; denied or unregistered is unavailable.
const notificationScript = `$ErrorActionPreference='Stop'
try {
  $null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
  $null=[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]
  $notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:BMN_UPDATE_APP_ID)
  if ($notifier.Setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled) { exit 3 }
  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
  $toast=$xml.CreateElement('toast'); $visual=$xml.CreateElement('visual'); $binding=$xml.CreateElement('binding')
  $binding.SetAttribute('template','ToastGeneric')
  foreach ($value in @($env:BMN_UPDATE_TITLE,$env:BMN_UPDATE_TEXT)) { $node=$xml.CreateElement('text'); [void]$node.AppendChild($xml.CreateTextNode($value)); [void]$binding.AppendChild($node) }
  [void]$visual.AppendChild($binding); [void]$toast.AppendChild($visual); [void]$xml.AppendChild($toast)
  $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch { exit 3 }
exit 0
`

export function systemPowerShell(environment = process.env) {
  const system = windowsEnvironmentValue(environment, 'SystemRoot')
  assert.ok(system, 'Windows system directory is unavailable')
  return join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe')
}
/** Only what WinForms needs, plus the window's literal data; no tokens or provider settings. */
function windowEnvironment(data, inherited) {
  const environment = {}
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN']) {
    const value = windowsEnvironmentValue(inherited, name)
    if (value !== undefined) environment[name] = value
  }
  if (environment.SystemRoot) environment.Path = join(environment.SystemRoot, 'System32')
  for (const [name, value] of Object.entries(data)) { assert.equal(typeof value, 'string'); environment[name] = value }
  return environment
}

function readDecisions(directory) {
  const events = []
  let names
  try { names = readdirSync(directory) } catch { return null }
  for (const name of names) {
    const match = /^([1-9][0-9]?)-([a-z-]{1,24})\.event$/u.exec(name)
    if (match) events.push({ sequence: Number(match[1]), action: match[2] })
  }
  events.sort((a, b) => a.sequence - b.sequence)
  // A gap or duplicate means the history is not the window's own complete record.
  return events.every((event, index) => event.sequence === index + 1) ? events : null
}

function ownedWindow(script, data, { parent, prepare = () => {}, start = spawn, inherited = process.env, executable = systemPowerShell(inherited) }) {
  const directory = join(parent, randomUUID())
  ensurePrivateDirectories([directory])
  prepare(directory)
  const child = start(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { env: windowEnvironment({ ...data, BMN_UPDATE_UI_DIRECTORY: directory }, inherited), stdio: 'ignore', windowsHide: false })
  let failed = false
  const exited = new Promise(resolve => {
    child.once('error', () => { failed = true; resolve({ code: null, failed }) })
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const running = () => !failed && child.exitCode === null && child.signalCode === null
  return { child, directory, exited, running, decisions: () => readDecisions(directory),
    stop: async () => { if (running()) { try { child.kill() } catch { /* Exit is still awaited below. */ } } return exited },
    dispose: () => { try { rmSync(directory, { recursive: true, force: true }) } catch { /* Private leftovers are inert. */ } } }
}

async function until(predicate, timeout, interval = 100) {
  // Check before the deadline: a parent busy in a synchronous step must not
  // misread a window that became ready meanwhile as unavailable.
  for (const deadline = Date.now() + timeout; ;) {
    const value = predicate()
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await delay(interval)
  }
}

/** Starts the progress window and resolves once it is ready or known unavailable. */
export async function startWindowsUpdateProgress({ parent, attemptId, progressPath, text, readyTimeout = 20000, closeTimeout = 10000, ...options }) {
  const observationId = randomUUID(), latch = new WindowsUpdateDecisionLatch({ attemptId, observationId })
  let window
  try { window = ownedWindow(progressScript, { BMN_UPDATE_PROGRESS: progressPath, BMN_UPDATE_ATTEMPT: attemptId, BMN_UPDATE_TEXT: text }, { parent, ...options }) }
  catch {
    latch.observeExit()
    return { ready: false, finish: async () => latch.state }
  }
  // An incomplete history is never a valid ledger; after readiness it suppresses opening.
  const ledger = () => ({ format: 1, attemptId, observationId, events: window.decisions() ?? [{ sequence: 0, action: 'incomplete' }] })
  const ready = await until(() => {
    const events = window.decisions()
    if (events?.some(event => event.action === 'ready')) return true
    if (!window.running()) return false
  }, readyTimeout)
  if (ready) {
    try { latch.accept(ledger()) } catch { await window.stop() }
  } else await window.stop()
  let finished
  return {
    ready: ready === true,
    /** Requests completion close, then reports whether opening BMN stays allowed. */
    finish: () => finished ??= (async () => {
      if (window.running()) {
        latch.requestCompletionClose()
        try { writeFileSync(join(window.directory, 'close.request'), '', { flag: 'wx' }) } catch { /* Then the bounded wait below decides. */ }
        if (await until(() => window.running() ? undefined : true, closeTimeout) === undefined) await window.stop()
      }
      await window.exited
      latch.observeExit(ledger())
      window.dispose()
      return latch.state
    })()
  }
}

/** Resolves to the owner's explicit choice; closing the window opens nothing. */
export async function askWindowsUpdateQuestion({ parent, title, text, buttons, ...options }) {
  const set = buttonSets.get(buttons)
  assert.ok(set, 'Unsupported update question')
  let window
  try {
    window = ownedWindow(questionScript, { BMN_UPDATE_TITLE: title, BMN_UPDATE_TEXT: text,
      BMN_UPDATE_BUTTON_LABELS: set.map(([label]) => label).join('\n'), BMN_UPDATE_BUTTON_ACTIONS: set.map(([, action]) => action).join('\n') },
    { parent, ...options })
  } catch { return 'unavailable' }
  try {
    await window.exited
    const events = window.decisions()
    if (!events?.length || events[0].action !== 'ready') return 'unavailable'
    const allowed = new Set(set.map(([, action]) => action).concat('closed'))
    return events.length === 2 && allowed.has(events[1].action) ? events[1].action : 'closed'
  } finally { window.dispose() }
}

export async function showWindowsUpdateLog({ parent, text, ...options }) {
  let window
  try {
    window = ownedWindow(logScript, {}, { parent, ...options,
      prepare: directory => writeFileSync(join(directory, 'log.txt'), text, { flag: 'wx', mode: 0o600 }) })
  } catch { return 'unavailable' }
  try {
    await window.exited
    return window.decisions()?.[0]?.action === 'ready' ? 'shown' : 'unavailable'
  } finally { window.dispose() }
}

export async function notifyWindowsUpdate({ title, text, start = spawn, inherited = process.env, executable = systemPowerShell(inherited), timeout = 30000 }) {
  let child
  try {
    child = start(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(notificationScript, 'utf16le').toString('base64')],
    { env: windowEnvironment({ BMN_UPDATE_APP_ID: WINDOWS_APP_ID, BMN_UPDATE_TITLE: title, BMN_UPDATE_TEXT: text }, inherited), stdio: 'ignore', windowsHide: true })
  } catch { return 'unavailable' }
  const deadline = new AbortController()
  const result = await Promise.race([new Promise(resolve => {
    child.once('error', () => resolve(null)); child.once('exit', code => resolve(code))
  }), delay(timeout, undefined, { signal: deadline.signal }).then(() => { try { child.kill() } catch { /* Reported unavailable. */ } return null }, () => null)])
  deadline.abort()
  return result === 0 ? 'submitted' : 'unavailable'
}
