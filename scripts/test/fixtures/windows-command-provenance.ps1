# Command-specific policy for the measured 64-bit Windows PowerShell 5.1 host.
# Metadata comes from the actual command, not from caller-supplied executable paths.
function Test-BMNCommandMetadata($metadata) {
 if($null -eq $metadata){return $false}
 foreach($key in @('name','source','commandType','moduleBase','moduleType','implementingAssembly','assemblyName','assemblyVersion','assemblyPublicKeyToken','is64Bit','version')) {
  if($null -eq $metadata.PSObject.Properties[$key]){return $false}
 }
 if($metadata.is64Bit -isnot [bool] -or !$metadata.is64Bit -or $metadata.version -isnot [string] -or $metadata.version -notmatch '^5\.1\.'){return $false}
 $expected=@{
  'Import-Module'=@('Microsoft.PowerShell.Core','System.Management.Automation');
  'Get-Command'=@('Microsoft.PowerShell.Core','System.Management.Automation');
  'Get-Module'=@('Microsoft.PowerShell.Core','System.Management.Automation');
  'ForEach-Object'=@('Microsoft.PowerShell.Core','System.Management.Automation');
  'Start-Sleep'=@('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Commands.Utility');
  'Add-Type'=@('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Commands.Utility');
  'ConvertFrom-Json'=@('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Commands.Utility');
  'ConvertTo-Json'=@('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Commands.Utility');
  'Join-Path'=@('Microsoft.PowerShell.Management','Microsoft.PowerShell.Commands.Management');
  'Expand-Archive'=@('Microsoft.PowerShell.Archive',$null)
 };
 if(!$expected.ContainsKey($metadata.name)){return $false}
 $source,$assembly=$expected[$metadata.name];
 if($metadata.source -cne $source){return $false}
 $folder=[IO.Path]::Combine($PSHOME,'Modules',$source)
 if($metadata.name -ceq 'Expand-Archive') {
  return ($metadata.commandType -ceq 'Function' -and $metadata.moduleType -ceq 'Manifest' -and
   $metadata.moduleBase -is [string] -and $metadata.moduleBase.Equals($folder,[StringComparison]::OrdinalIgnoreCase) -and
   $null -eq $metadata.implementingAssembly -and $null -eq $metadata.assemblyName -and $null -eq $metadata.assemblyVersion -and $null -eq $metadata.assemblyPublicKeyToken)
 }
 if($metadata.commandType -cne 'Cmdlet'){return $false}
 if($source -ceq 'Microsoft.PowerShell.Core') {
  if($null -ne $metadata.moduleBase -or $null -ne $metadata.moduleType){return $false}
 } else {
  if($metadata.moduleType -cne 'Manifest' -or $metadata.moduleBase -isnot [string]){return $false}
  if(!$metadata.moduleBase.Equals($PSHOME,[StringComparison]::OrdinalIgnoreCase) -and
     !$metadata.moduleBase.Equals($folder,[StringComparison]::OrdinalIgnoreCase)){return $false}
 }
 $location=[IO.Path]::Combine($env:SystemRoot,'Microsoft.NET','assembly','GAC_MSIL',$assembly,'v4.0_3.0.0.0__31bf3856ad364e35',$assembly+'.dll');
 return ($metadata.assemblyName -ceq $assembly -and $metadata.assemblyVersion -ceq '3.0.0.0' -and
  $metadata.assemblyPublicKeyToken -ceq '31bf3856ad364e35' -and $metadata.implementingAssembly -is [string] -and
  $metadata.implementingAssembly.Equals($location,[StringComparison]::OrdinalIgnoreCase))
}
function Test-BMNOriginalCommandMetadata($metadata) {
 if($metadata.source -cne $(if($metadata.name -ceq 'Expand-Archive'){'Microsoft.PowerShell.Archive'}elseif($metadata.name -ceq 'Join-Path'){'Microsoft.PowerShell.Management'}elseif(@('Start-Sleep','Add-Type','ConvertFrom-Json','ConvertTo-Json') -ccontains $metadata.name){'Microsoft.PowerShell.Utility'}else{'Microsoft.PowerShell.Core'})){return $false}
 if($metadata.commandType -cne $(if($metadata.name -ceq 'Expand-Archive'){'Function'}else{'Cmdlet'})){return $false}
 if($metadata.source -cne 'Microsoft.PowerShell.Core') {
  $folder=[IO.Path]::Combine($PSHOME,'Modules',$metadata.source)
  if($metadata.moduleBase -isnot [string] -or !$metadata.moduleBase.Equals($folder,[StringComparison]::OrdinalIgnoreCase)){return $false}
 }
 return $true
}
function Assert-BMNCommandControls($rows) {
 $names=@('Import-Module','Get-Command','Get-Module','ForEach-Object','Start-Sleep','Add-Type','ConvertFrom-Json','ConvertTo-Json','Join-Path','Expand-Archive');
 if($rows.Count -ne 10){throw 'Incomplete measured command dependencies'}
 foreach($name in $names){if(@($rows | ForEach-Object {if($_.name -ceq $name){$true}}).Count -ne 1){throw 'Missing or duplicated measured command dependency'}}
 $originalRejected=0;$negativeRejected=0
 foreach($row in $rows) {
  if(!(Test-BMNOriginalCommandMetadata $row)){$originalRejected++}
  if(!(Test-BMNCommandMetadata $row)){throw ('Measured command dependency refused: '+$row.name)}
  foreach($property in @('source','commandType','moduleBase','assemblyName','assemblyVersion','assemblyPublicKeyToken','implementingAssembly')) {
   $bad=$row.PSObject.Copy();$bad.$property='synthetic-wrong-member';
   if(Test-BMNCommandMetadata $bad){throw ('Dependency substitution accepted: '+$row.name+':'+$property)}
   $negativeRejected++
  }
  $missing=$row.PSObject.Copy();$missing.PSObject.Properties.Remove('source');
  if(Test-BMNCommandMetadata $missing){throw 'Missing dependency metadata accepted'}
  $negativeRejected++
 }
 if($originalRejected -ne 5){throw 'Original module-base discriminator changed'}
 $core=$rows[0].PSObject.Copy();$core.implementingAssembly='synthetic-outside-assembly.dll';
 if(!(Test-BMNOriginalCommandMetadata $core) -or (Test-BMNCommandMetadata $core)){throw 'Original/current assembly-path discriminator did not separate'}
 [Console]::Error.WriteLine((ConvertTo-Json -Compress @{stage='command-provenance-controls';measured=10;originalRejected=$originalRejected;substitutionsRejected=$negativeRejected;originalAcceptedOutsideAssembly=$true;amendedRejectedOutsideAssembly=$true}))
}
