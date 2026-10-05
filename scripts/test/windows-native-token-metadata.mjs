// First, read-only token prerequisites; no WMI, token creation or privilege enablement.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {windowsEnvironmentValue} from '../../apps/desktop/bin/windows-env.mjs'
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true')
const system=windowsEnvironmentValue(process.env,'SystemRoot');assert.ok(system)
const source=readFileSync(new URL('./fixtures/windows-native-token-metadata.cs',import.meta.url),'utf8')
const script="$ErrorActionPreference='Stop';Import-Module ([IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));$PSModuleAutoLoadingPreference='None';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$source=[Console]::In.ReadToEnd();$stage='compile';try{Add-Type -TypeDefinition $source;$stage='query';[Console]::Out.Write((ConvertTo-Json -Depth 12 -Compress ([BMNTokenMetadata]::Collect())))}catch{$actual=$_.Exception;for($i=0;$i -lt 8 -and $actual.InnerException;$i++){$actual=$actual.InnerException};[Console]::Out.Write((ConvertTo-Json -Compress @{scope='token-metadata-only';ownership='UNVERIFIED';processMeasurementAllowed=$false;failureStage=$stage;exceptionType=$actual.GetType().Name;nativeErrorCode=if($actual -is [ComponentModel.Win32Exception]){$actual.NativeErrorCode}else{$null}}));exit 1}"
const result=spawnSync(join(system,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:source,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:256*1024})
let observed
try{observed=JSON.parse(result.stdout)}catch{observed={scope:'token-metadata-only',ownership:'UNVERIFIED',inconclusive:true}}
const receipt={...observed,exitCode:result.status,launchError:result.error?.code??null,stderrBytes:Buffer.byteLength(result.stderr??'')}
const destination=resolve('test-results/windows-native-token-metadata.json');mkdirSync(resolve('test-results'),{recursive:true});writeFileSync(destination,JSON.stringify(receipt,null,2))
assert.equal(result.error,undefined);assert.equal(result.status,0,'Native token metadata collection did not complete')
assert.equal(receipt.scope,'token-metadata-only');assert.equal(receipt.ownership,'UNVERIFIED');assert.equal(receipt.processMeasurementAllowed,false)
assert.ok(receipt.current&&Array.isArray(receipt.current.privileges)&&Array.isArray(receipt.current.groups))
console.log(JSON.stringify({nativeTokenMetadata:'collected',ownership:'UNVERIFIED',processMeasurementAllowed:false}))
