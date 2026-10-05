// MODULE: windows-ui-automation.mjs - drives real top-level windows of one owned process through UI Automation
// Test-only. It finds a window by process ID and exact title, reports its
// controls' names, values, enabled state, focus and bounds, and then optionally
// invokes one named button or closes the window as a user would.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const script = `$ErrorActionPreference='Stop'
Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$request=ConvertFrom-Json $env:BMN_UIA_REQUEST
$A=[Windows.Automation.AutomationElement]
$condition=New-Object Windows.Automation.AndCondition((New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty,[int]$request.processId)),(New-Object Windows.Automation.PropertyCondition($A::NameProperty,[string]$request.title)))
$deadline=[DateTime]::UtcNow.AddMilliseconds([int]$request.timeoutMs)
do {
  $window=$A::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,$condition)
  if ($window -and (-not $request.until -or @($window.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition($A::NameProperty,[string]$request.until)))).Count -gt 0)) { break }
  $window=$null; Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $window) { [Console]::Out.Write('{"found":false}'); exit 0 }
$rows=@(foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)) {
  $value=$null; $pattern=$null
  if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $value=$pattern.Current.Value }
  $box=$element.Current.BoundingRectangle
  [pscustomobject]@{ type=$element.Current.ControlType.ProgrammaticName; name=$element.Current.Name; value=$value
    enabled=$element.Current.IsEnabled; focused=$element.Current.HasKeyboardFocus; width=[int]$box.Width; height=[int]$box.Height }
})
$frame=$window.Current.BoundingRectangle
$result=[pscustomobject]@{ found=$true; title=$window.Current.Name; width=[int]$frame.Width; height=[int]$frame.Height; elements=$rows; acted=$false }
if ($request.action -eq 'invoke') {
  $button=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.AndCondition((New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty,[Windows.Automation.ControlType]::Button)),(New-Object Windows.Automation.PropertyCondition($A::NameProperty,[string]$request.name)))))
  if ($button) { $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); $result.acted=$true }
} elseif ($request.action -eq 'close') {
  $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close(); $result.acted=$true
}
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 -InputObject $result))
`

/** action: 'inspect' | 'invoke' (name = button) | 'close'; until = a control name that must exist first. */
export function automateWindow({ processId, title, action = 'inspect', name, until, timeoutMs = 20000 }) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, BMN_UIA_REQUEST: JSON.stringify({ processId, title, action, name, until, timeoutMs }) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = '', errors = ''
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { errors += bytes })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('UI Automation request timed out')) }, timeoutMs + 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error(`UI Automation failed (${code}): ${errors.slice(0, 2000)}`)); return }
      try { resolve(JSON.parse(output)) } catch { reject(new Error('UI Automation returned no result')) }
    })
  })
}
