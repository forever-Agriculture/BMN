// MODULE: windows-ui-automation.mjs - drives real top-level windows of one owned process through UI Automation
// Test-only. It finds a window by process ID and exact title, reports its
// controls' names, values, enabled state, focus and bounds, and then optionally
// invokes one named button or closes the window as a user would.
// The managed UI Automation client exposes WinForms child controls only as
// generic HWND panes (CI run 37281677152), so each control's role, value and
// default action come from its own Active Accessibility object, the interface
// WinForms implements for assistive technology.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Window text comes from WM_GETTEXT, so a literal '&' is reported as shown;
// accessible names drop it as a mnemonic marker.
const helperSource = `using System;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;
public static class BmnAccessible {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiInfo {
    public uint size, flags; public IntPtr active, focus, capture, menuOwner, moveSize, caret; public Rect caretRect;
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  public static long[] Focus(IntPtr window) {
    uint owner, foregroundOwner; uint thread=GetWindowThreadProcessId(window,out owner);
    IntPtr foreground=GetForegroundWindow(); GetWindowThreadProcessId(foreground,out foregroundOwner);
    GuiInfo info=new GuiInfo(); info.size=(uint)Marshal.SizeOf(typeof(GuiInfo));
    bool ok=GetGUIThreadInfo(thread,ref info);
    return new long[] { foreground.ToInt64(), foregroundOwner, ok ? 1 : 0, info.active.ToInt64(), info.focus.ToInt64() };
  }
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr window, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendTextMessage(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
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
  public static string Text(IntPtr window) {
    IntPtr length, copied;
    if (SendMessageTimeout(window, 0x000E, IntPtr.Zero, IntPtr.Zero, 0x0002, 2000, out length) == IntPtr.Zero) return null;
    StringBuilder buffer = new StringBuilder(length.ToInt32() + 1);
    if (SendTextMessage(window, 0x000D, (IntPtr)buffer.Capacity, buffer, 0x0002, 2000, out copied) == IntPtr.Zero) return null;
    return buffer.ToString();
  }
}
`
const loadAccessibility = `$accessibility=[Reflection.Assembly]::Load('Accessibility, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a').Location
`
const compileScript = `$ErrorActionPreference='Stop'
${loadAccessibility}Add-Type -ReferencedAssemblies $accessibility -TypeDefinition $env:BMN_UIA_SOURCE -OutputAssembly $env:BMN_UIA_ASSEMBLY -OutputType Library
`
const script = `$ErrorActionPreference='Stop'
Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'))
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
${loadAccessibility}Add-Type -Path $env:BMN_UIA_ASSEMBLY
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
  $json=ConvertTo-Json -Compress -Depth 8 -InputObject $value
  # Escaped, so the result never depends on the console code page.
  [Console]::Out.Write([regex]::Replace($json,'[^\\x00-\\x7F]',[Text.RegularExpressions.MatchEvaluator]{ param($match) '\\u{0:x4}' -f [int][char]$match.Value }))
}
if (-not $window) {
  $titles=@(); try { $titles=@(foreach ($other in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children,(New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty,[int]$request.processId)))) { $other.Current.Name }) } catch {}
  Write-Result ([pscustomobject]@{ found=$false; titles=$titles; searchErrors=$searchErrors }); exit 0
}
function Capture-Window {
if(-not [BmnAccessible]::IsWindow([IntPtr][int64]$window.Current.NativeWindowHandle)) { throw [InvalidOperationException]::new('Owned window no longer exists') }
$rows=@(foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)) {
  $value=$null; $pattern=$null
  if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $value=$pattern.Current.Value }
  $box=$element.Current.BoundingRectangle; $handle=[IntPtr][int64]$element.Current.NativeWindowHandle
  $role=$null; $accessibleValue=$null; $accessibleState=$null; $accessibleError=$null; $text=$null
  if ($handle -ne [IntPtr]::Zero) {
    try { $described=[BmnAccessible]::Describe($handle); $role=$described[0]; $accessibleValue=$described[2]; $accessibleState=$described[3] } catch { $accessibleError=Get-Code $_.Exception }
    try { $text=[BmnAccessible]::Text($handle) } catch {}
  }
  [pscustomobject]@{ type=$element.Current.ControlType.ProgrammaticName; className=$element.Current.ClassName; handle=[int64]$element.Current.NativeWindowHandle; accessibleRole=$role; accessibleError=$accessibleError; accessibleState=$accessibleState
    msaaFocused=($null -ne $accessibleState -and ([int]$accessibleState -band 4) -ne 0); msaaDefault=($null -ne $accessibleState -and ([int]$accessibleState -band 256) -ne 0)
    name=$element.Current.Name; text=$text; value=$(if ($null -ne $value) { $value } else { $accessibleValue })
    enabled=$element.Current.IsEnabled; focused=$element.Current.HasKeyboardFocus; width=[int]$box.Width; height=[int]$box.Height }
})
$frame=$window.Current.BoundingRectangle
$focus=[BmnAccessible]::Focus([IntPtr][int64]$window.Current.NativeWindowHandle)
$foreignImage=$null
if($focus[1] -gt 0 -and $focus[1] -ne [int]$request.processId) {
  try { $foreignImage=(Get-Process -Id $focus[1]).ProcessName } catch { $foreignImage='unavailable' }
}
$uiaFocus=$null
try {
  $focused=$A::FocusedElement
  if($focused) { $uiaFocus=@{ pid=$focused.Current.ProcessId; owned=($focused.Current.ProcessId -eq [int]$request.processId); name=$(if($focused.Current.ProcessId -eq [int]$request.processId){$focused.Current.Name}else{$null}) } }
} catch {}
$now=([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds()
return [pscustomobject]@{ found=$true; title=$window.Current.Name; width=[int]$frame.Width; height=[int]$frame.Height
  capturedAtMs=$now; readyAgeMs=$(if($request.readyAtMs){$now-[long]$request.readyAtMs}else{$null})
  focus=@{ foregroundHandle=$focus[0]; foregroundPid=$focus[1]; foreignImage=$foreignImage; threadQueryOk=($focus[2] -eq 1); activeHandle=$focus[3]; focusedHandle=$focus[4]; uia=$uiaFocus }
  elements=$rows; acted=$false; actError=$null }
}
$result=Capture-Window
$first=[pscustomobject]@{ capturedAtMs=$result.capturedAtMs; readyAgeMs=$result.readyAgeMs; focus=$result.focus; elements=$result.elements }
$samples=@($first)
if($request.observeWindowLossForSelfTest) {
 $diagnosticHwnd=[IntPtr][int64]$window.Current.NativeWindowHandle;
 $first | Add-Member -NotePropertyName windowAlive -NotePropertyValue ([BmnAccessible]::IsWindow($diagnosticHwnd));
}
if($request.closeAfterFirstForSelfTest) {
 $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close();
 if($request.observeWindowLossForSelfTest) { $result | Add-Member -NotePropertyName closeReturnedAtMs -NotePropertyValue ([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() }
}
if($request.forceFocusSamplesForSelfTest -or ($request.focusName -and @($result.elements | Where-Object { $_.name -ceq [string]$request.focusName -and -not $_.focused }).Count -gt 0)) {
  for($sample=0;$sample -lt 2;$sample++) {
    Start-Sleep -Milliseconds 250
    $alive=$null; if($request.observeWindowLossForSelfTest) { $alive=[BmnAccessible]::IsWindow($diagnosticHwnd) }
    try {
      $captured=Capture-Window;
      if($request.observeWindowLossForSelfTest) { $captured | Add-Member -NotePropertyName windowAlive -NotePropertyValue $alive }
      $samples+=$captured;
    }
    catch { if($request.propagateFollowUpErrorForSelfTest){throw}; $samples+=[pscustomobject]@{ capturedAtMs=([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds(); captureError=(Get-Code $_.Exception); windowAlive=$alive } }
  }
}
$result | Add-Member -NotePropertyName focusSamples -NotePropertyValue $samples
if ($request.action -eq 'invoke') {
  $rows=$result.elements
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

const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const encoded = text => Buffer.from(text, 'utf16le').toString('base64')
let helper
/** Compiles the accessibility helper once per test process; each request only loads it. */
function accessibilityHelper() {
  helper ??= new Promise((resolve, reject) => {
    const assembly = join(tmpdir(), `bmn-uia-${process.pid}-${createHash('sha256').update(helperSource).digest('hex').slice(0, 12)}.dll`)
    if (existsSync(assembly)) { resolve(assembly); return }
    process.once('exit', () => { try { rmSync(assembly, { force: true }) } catch { /* A loaded copy is removed with the temporary folder. */ } })
    const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(compileScript)],
      { env: { ...process.env, BMN_UIA_SOURCE: helperSource, BMN_UIA_ASSEMBLY: assembly }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let errors = ''
    child.stderr.on('data', bytes => { errors += bytes })
    child.once('error', reject)
    child.once('exit', code => code === 0 && existsSync(assembly) ? resolve(assembly) : reject(new Error(`UI Automation helper did not compile (${code}): ${errors.slice(0, 2000)}`)))
  })
  return helper
}

/**
 * action: 'inspect' | 'invoke' (name = button) | 'close'; until = a control name that must exist first.
 * The search ends as soon as the window is found. Its 90 s bound covers update windows that took
 * 28-46 s to show under the parallel CI inventory (run 37299667758); startup time is not asserted here.
 */
export async function automateWindow({ processId, title, action = 'inspect', name, until, focusName, readyAtMs, forceFocusSamplesForSelfTest = false, closeAfterFirstForSelfTest = false, propagateFollowUpErrorForSelfTest = false, observeWindowLossForSelfTest = false, timeoutMs = 90000 }) {
  const assembly = await accessibilityHelper()
  const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded(script)],
    { env: { ...process.env, BMN_UIA_ASSEMBLY: assembly, BMN_UIA_REQUEST: JSON.stringify({ processId, title, action, name, until, focusName, readyAtMs, forceFocusSamplesForSelfTest, closeAfterFirstForSelfTest, propagateFollowUpErrorForSelfTest, observeWindowLossForSelfTest, timeoutMs }) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
      for (const view of [result, ...(result.focusSamples ?? [])]) {
        for (const element of view.elements ?? []) element.role = roles.get(element.accessibleRole) ?? null
      }
      resolve(result)
    })
  })
}
