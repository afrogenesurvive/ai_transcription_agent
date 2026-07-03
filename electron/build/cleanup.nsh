;;
;; cleanup.nsh — NSIS include for the Transcription Agent uninstaller.
;;
;; Included in both the install and uninstall sections. On uninstall:
;;   1. Removes user app data from %APPDATA%\Transcription Agent
;;   2. Removes Ollama if the auto-install sentinel file is present
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

;;
;; Uninstall section that gets called when the user uninstalls via
;; Add/Remove Programs or the uninstaller shortcut.
;;
Section "Uninstall"
  ; Inherits from electron-builder's default uninstall section

  ; Remove user data (matches deleteAppDataOnUninstall: true behavior,
  ; but also catches edge cases)
  !insertmacro removeUserData

  ; Remove Ollama if this app auto-installed it
  !insertmacro removeOllamaIfAutoInstalled
SectionEnd
