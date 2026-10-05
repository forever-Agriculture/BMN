// MODULE: windows-ui-automation.mjs - drives real top-level windows of one owned process through UI Automation
// Test-only. It finds a window by process ID and exact title, reports its
// controls' names, values, enabled state, focus and bounds, and then optionally
// invokes one named button or closes the window as a user would.
// The managed UI Automation client exposes WinForms child controls only as
// generic HWND panes (CI run 37281677152), so each control's role, value and
// default action come from its own Active Accessibility object, the interface
// WinForms implements for assistive technology.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const script = `$ErrorActionPreference='Stop'
Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$accessibility=[Reflection.Assembly]::Load('Accessibility, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a').Location
Add-Type -ReferencedAssemblies $accessibility -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Accessibility;
public static class BmnAccessible {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr window, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
  static IAccessible Find(IntPtr window) {
    Guid iid = typeof(IAccessible).GUID; IAccessible accessible;
    int status = AccessibleObjectFromWindow(window, 0xFFFFFFFC, ref iid, out accessible);
    if (status != 0 || accessible == null) throw new COMException("No accessible object", status);
    return accessible;
  }
  public static object[] Describe(IntPtr window) {
    IAccessible accessible = Find(window);
    object role = accessible.get_accRole(0), state = accessible.get_accState(0);
    string value = null;
    try { value = accessible.get_accValue(0); } catch (COMException) { }
    return new object[] { role is int ? (int)role : -1, accessible.get_accName(0), value, state is int ? (int)state : 0 };
  }
  public static void Press(IntPtr window) { Find(window).accDoDefaultAction(0); }
}
'@
function Get-Code($exception) { while ($exception.InnerException) { $exception=$exception.InnerException }; return ('0x{0:X8}' -f $exception.HResult) }
$request=ConvertFrom-Json $env:BMN_UIA_REQUEST
$A=[Windows.Automation.AutomationElement]
$condition=New-Object Windows.Automation.AndCondition((New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty,[int]$request.processId)),(New-Object Windows.Automation.PropertyCondition($A::NameProperty,[string]$request.title)))
$deadline=[DateTime]::UtcNow.AddMilliseconds([int]$request.timeoutMs)
$searchErrors=@()
do {
  # Other processes' windows appear and vanish during the search; that is a retry, not a result.
  try {
    $window=$A::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,$condition)
    if ($window -and (-not $request.until -or @($window.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition($A::NameProperty,[string]$request.until)))).Count -gt 0)) { break }
  } catch { if ($searchErrors.Count -lt 5) { $searchErrors+=(Get-Code $_.Exception) } }
  $window=$null; Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
function Write-Result($value) {
  $json=ConvertTo-Json -Compress -Depth 4 -InputObject $value
  # Escaped, so the result never depends on the console code page.
  [Console]::Out.Write([regex]::Replace($json,'[^\\x00-\\x7F]',[Text.RegularExpressions.MatchEvaluator]{ param($match) '\\u{0:x4}' -f [int][char]$match.Value }))
}
if (-not $window) {
  $titles=@(); try { $titles=@(foreach ($other in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children,(New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty,[int]$request.processId)))) { $other.Current.Name }) } catch {}
  Write-Result ([pscustomobject]@{ found=$false; titles=$titles; searchErrors=$searchErrors }); exit 0
}
$rows=@(foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)) {
  $value=$null; $pattern=$null
  if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $value=$pattern.Current.Value }
  $box=$element.Current.BoundingRectangle; $handle=[IntPtr][int64]$element.Current.NativeWindowHandle
  $role=$null; $accessibleValue=$null; $accessibleError=$null
  if ($handle -ne [IntPtr]::Zero) {
    try { $described=[BmnAccessible]::Describe($handle); $role=$described[0]; $accessibleValue=$described[2] } catch { $accessibleError=Get-Code $_.Exception }
  }
  [pscustomobject]@{ type=$element.Current.ControlType.ProgrammaticName; className=$element.Current.ClassName; handle=[int64]$element.Current.NativeWindowHandle; accessibleRole=$role; accessibleError=$accessibleError
    name=$element.Current.Name; value=$(if ($null -ne $value) { $value } else { $accessibleValue })
    enabled=$element.Current.IsEnabled; focused=$element.Current.HasKeyboardFocus; width=[int]$box.Width; height=[int]$box.Height }
})
$frame=$window.Current.BoundingRectangle
$result=[pscustomobject]@{ found=$true; title=$window.Current.Name; width=[int]$frame.Width; height=[int]$frame.Height; elements=$rows; acted=$false; actError=$null }
if ($request.action -eq 'invoke') {
  $target=@($rows | Where-Object { $_.accessibleRole -eq 43 -and $_.name -ceq [string]$request.name }) | Select-Object -First 1
  if ($target) {
    try { [BmnAccessible]::Press([IntPtr]$target.handle); $result.acted=$true } catch { $result.actError=Get-Code $_.Exception }
  }
} elseif ($request.action -eq 'close') {
  $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close(); $result.acted=$true
}
Write-Result $result
`

// Active Accessibility roles (oleacc.h ROLE_SYSTEM_*) the update windows use.
const roles = new Map([[41, 'static text'], [42, 'editable text'], [43, 'button'], [48, 'progress bar']])

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
      let result
      try { result = JSON.parse(output) } catch { reject(new Error('UI Automation returned no result')); return }
      for (const element of result.elements ?? []) element.role = roles.get(element.accessibleRole) ?? null
      resolve(result)
    })
  })
}
