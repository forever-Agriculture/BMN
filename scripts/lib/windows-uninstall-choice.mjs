import assert from 'node:assert/strict'

export const windowsUninstallDialog = `$ErrorActionPreference='Stop'; Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
$form=[Windows.Forms.Form]::new(); $form.Text='Uninstall BMN'; $form.ClientSize=[Drawing.Size]::new(540,240); $form.StartPosition='CenterScreen'; $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false; $form.MinimizeBox=$false;
$label=[Windows.Forms.Label]::new(); $label.Location=[Drawing.Point]::new(16,16); $label.Size=[Drawing.Size]::new(508,64); $label.Text='Remove BMN? Keep the option below unchecked to retain user data and recovery snapshots. Configuration and the offline recovery runtime are retained.';
$check=[Windows.Forms.CheckBox]::new(); $check.Location=[Drawing.Point]::new(16,88); $check.Size=[Drawing.Size]::new(508,28); $check.Text='&Permanently delete ALL contents of the data folder below'; $check.Checked=($env:BMN_REMOVE_DATA -eq '1');
$path=[Windows.Forms.TextBox]::new(); $path.Location=[Drawing.Point]::new(16,124); $path.Size=[Drawing.Size]::new(508,28); $path.ReadOnly=$true; $path.Text=$env:BMN_UNINSTALL_DATA; $path.AccessibleName='Data folder to delete';
$warning=[Windows.Forms.Label]::new(); $warning.Location=[Drawing.Point]::new(16,156); $warning.Size=[Drawing.Size]::new(508,28); $warning.Text='This includes files you placed there. Project files outside this folder are preserved.';
$ok=[Windows.Forms.Button]::new(); $ok.Location=[Drawing.Point]::new(316,196); $ok.Size=[Drawing.Size]::new(100,28); $ok.Text='&Uninstall'; $ok.DialogResult='OK';
$cancel=[Windows.Forms.Button]::new(); $cancel.Location=[Drawing.Point]::new(424,196); $cancel.Size=[Drawing.Size]::new(100,28); $cancel.Text='&Cancel'; $cancel.DialogResult='Cancel';
$form.Controls.AddRange(@($label,$check,$path,$warning,$ok,$cancel)); $form.AcceptButton=$ok; $form.CancelButton=$cancel;
try { $result=$form.ShowDialog(); [Console]::Write($(if($result -ne 'OK'){'cancel'}elseif($check.Checked){'remove-all'}else{'retain'})) } finally { $form.Dispose() }
`

export function chooseWindowsUninstallData({ dataRoot, initialRemoveData = false, show }) {
  assert.equal(typeof show, 'function')
  const result = show(windowsUninstallDialog, { BMN_REMOVE_DATA: initialRemoveData ? '1' : '0', BMN_UNINSTALL_DATA: dataRoot })
  assert.ok(['retain', 'remove-all', 'cancel'].includes(result), 'Uninstall choice was not confirmed')
  return result
}
