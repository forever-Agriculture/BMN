// Exact-source diagnostic fence. These are the actual worker helper preambles;
// no selectors are copied here. Unknown helper variants cannot certify a pair.
export const originalQueryPrefix = "$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));\n"
export const candidateQueryPrefix = originalQueryPrefix.slice(0, -1) + "Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/CimCmdlets/CimCmdlets.psd1'));\n"
export const exactInstalledQueries = new Map([
  ['822d6f6cece77efcb00e90a49419bd0ecc4165c5b80e0045fb9300e7eda891f2', { operation: 'observe-apps', variant: 'original' }],
  ['32772e37c027a2572f54be17529502829c580df2faedefee41fefceadb0afff1', { operation: 'observe-selected-apps', variant: 'original' }],
  ['e9c6d5c95d22f669af8ad8f14325fd493a96a4478bcc7d96ed8393aa41f8ef3a', { operation: 'observe-mapped-engines', variant: 'original' }],
  ['9de0d1c34a02419c0c3f8451a74468b569977dd4d646646f9ae4bfdb1a30d5db', { operation: 'observe-apps', variant: 'candidate' }],
  ['bf500afdff12cd952922ef762fc5845fe0b2f229cc97d8030ed4d1aae4f822c9', { operation: 'observe-selected-apps', variant: 'candidate' }],
  ['2fdf99192826a0b88d9e30c2594a5c2d8fe9a003ef3ba61982ff9e5c7207533f', { operation: 'observe-mapped-engines', variant: 'candidate' }]
])
