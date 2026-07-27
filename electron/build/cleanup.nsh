;;
;; cleanup.nsh — NSIS include for the Transcription Agent uninstaller.
;;
;; Provides macros for cleaning up user data and auto-installed
;; dependencies (Ollama) on uninstall.
;;
;; Included by installer.nsh (which is included by electron-builder's
;; generated NSIS script).
;;

!macro removeUserData
  ; Remove app user data directory
  RMDir /r "$APPDATA\Transcription Agent"
!macroend

!macro removeOllamaIfAutoInstalled
  ; Check for the auto-install sentinel file
  IfFileExists "$APPDATA\Transcription Agent\.ollama-auto-installed" 0 +4
    ; Sentinel found — Ollama was installed by this app, remove it
    RMDir /r "$LOCALAPPDATA\Programs\Ollama"
    RMDir /r "$PROGRAMFILES\Ollama"
    Delete "$APPDATA\Transcription Agent\.ollama-auto-installed"
!macroend

!macro removeInstallDir
  ; Remove the application install directory ($INSTDIR = %ProgramFiles%\Transcription Agent).
  ; electron-builder's default uninstaller removes all files it installed, then attempts
  ; RMDir on $INSTDIR. This macro ensures any untracked files (created at runtime, etc.)
  ; are also cleaned up so no empty or orphaned directory is left behind.
  ;
  ; This should be called AFTER electron-builder's default uninstall section has run,
  ; so that all tracked files are already removed.
  RMDir /r "$INSTDIR"
!macroend
