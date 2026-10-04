import assert from 'node:assert/strict'

export const windowsUninstallDialog = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
$form=New-Object Windows.Forms.Form; $form.Text='Uninstall BMN'; $form.ClientSize=New-Object Drawing.Size(540,240); $form.StartPosition='CenterScreen'; $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false; $form.MinimizeBox=$false;
$label=New-Object Windows.Forms.Label; $label.Location=New-Object Drawing.Point(16,16); $label.Size=New-Object Drawing.Size(508,64); $label.Text='Remove BMN? Keep the option below unchecked to retain user data and recovery snapshots. Configuration and the offline recovery runtime are retained.';
$check=New-Object Windows.Forms.CheckBox; $check.Location=New-Object Drawing.Point(16,88); $check.Size=New-Object Drawing.Size(508,28); $check.Text='&Permanently delete ALL contents of the data folder below'; $check.Checked=($env:BMN_REMOVE_DATA -eq '1');
$path=New-Object Windows.Forms.TextBox; $path.Location=New-Object Drawing.Point(16,124); $path.Size=New-Object Drawing.Size(508,28); $path.ReadOnly=$true; $path.Text=$env:BMN_UNINSTALL_DATA; $path.AccessibleName='Data folder to delete';
$warning=New-Object Windows.Forms.Label; $warning.Location=New-Object Drawing.Point(16,156); $warning.Size=New-Object Drawing.Size(508,28); $warning.Text='This includes files you placed there. Project files outside this folder are preserved.';
$ok=New-Object Windows.Forms.Button; $ok.Location=New-Object Drawing.Point(316,196); $ok.Size=New-Object Drawing.Size(100,28); $ok.Text='&Uninstall'; $ok.DialogResult='OK';
$cancel=New-Object Windows.Forms.Button; $cancel.Location=New-Object Drawing.Point(424,196); $cancel.Size=New-Object Drawing.Size(100,28); $cancel.Text='&Cancel'; $cancel.DialogResult='Cancel';
$form.Controls.AddRange(@($label,$check,$path,$warning,$ok,$cancel)); $form.AcceptButton=$ok; $form.CancelButton=$cancel;
try { $result=$form.ShowDialog(); [Console]::Write($(if($result -ne 'OK'){'cancel'}elseif($check.Checked){'remove-all'}else{'retain'})) } finally { $form.Dispose() }
`

export function chooseWindowsUninstallData({ dataRoot, initialRemoveData = false, show }) {
  assert.equal(typeof show, 'function')
  const result = show(windowsUninstallDialog, { BMN_REMOVE_DATA: initialRemoveData ? '1' : '0', BMN_UNINSTALL_DATA: dataRoot })
  assert.ok(['retain', 'remove-all', 'cancel'].includes(result), 'Uninstall choice was not confirmed')
  return result
}
