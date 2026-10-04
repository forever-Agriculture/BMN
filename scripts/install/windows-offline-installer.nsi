; Custom section deliberately avoids stock early uninstall / in-place extraction.
; Every payload byte is embedded: runtime users need no Node, compiler or network.
Unicode true
RequestExecutionLevel user
Name "BMN"
OutFile "${BMN_SETUP_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\BMN"
ShowInstDetails show
SetCompressor /SOLID lzma
Page instfiles

Section "Install BMN"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${BMN_PAYLOAD}\*"
  IfErrors failed
  DetailPrint "Waiting for BMN to close; validating the staged release. User data is retained."
  ExecWait '"$PLUGINSDIR\payload\resources\install\BMN-install-runner.exe" --install "$PLUGINSDIR\payload" "$INSTDIR" "$LOCALAPPDATA\BMN\data" "$PLUGINSDIR\install-result.txt"' $0
  IfErrors failed
  StrCmp $0 0 complete
failed:
  StrCpy $1 "Installation is incomplete. A candidate may already be selected. Retained payloads and recovery snapshots are preserved; close BMN and rerun this installer to repair installation."
  ClearErrors
  FileOpen $2 "$PLUGINSDIR\install-result.txt" r
  IfErrors show_failure
  FileRead $2 $1 512
  FileClose $2
show_failure:
  MessageBox MB_OK|MB_ICONSTOP "$1"
  SetErrorLevel 1
  Abort
complete:
  DetailPrint "BMN installed. Open it from the Start menu."
  SetErrorLevel 0
SectionEnd
