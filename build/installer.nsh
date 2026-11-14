; Extra steps for the Windows installer.
;
; Registers Runes under "App Paths", which is how Windows finds a program by name without it
; being on PATH: after installing, `runes` works from the Run box (Win+R) and `start runes`
; works in a terminal. PATH itself is left alone: appending to it from an installer cannot
; be done safely without knowing its length, and a mistake there breaks other programs.

!macro customInstall
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\runes.exe" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\runes.exe" "Path" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\runes.exe"
!macroend
