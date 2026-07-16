;;
;; installer.nsh — Custom NSIS branding & progress messages for
;; Transcription Agent installer.
;;
;; Included by electron-builder's generated NSIS script.
;; electron-builder handles ALL file extraction (core app + extraResources)
;; automatically. This file only adds branded UI messages.
;;
;; Usage in electron-builder config:
;;   "nsis": {
;;     "include": "build/installer.nsh",
;;     ...
;;   }
;;

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; ── Branding ──

BrandingText "Transcription Agent Installer"

; ── Custom Welcome Page ──

!macro customWelcomePage
  Page custom welcomePage
!macroend

Var WelcomeDialog
Var WelcomeTitle
Var WelcomeText
Var WelcomeLaunchCheckbox
Var RunAfterInstall

Function welcomePage
  nsDialogs::Create 1018
  Pop $WelcomeDialog

  ${If} $WelcomeDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 40u "🎙️  Transcription Agent"
  Pop $WelcomeTitle
  CreateFont $1 "MS Shell Dlg 2" 18 700
  SendMessage $WelcomeTitle ${WM_SETFONT} $1 1

  ${NSD_CreateLabel} 0 46u 100% -50u \
    "This installer will set up Transcription Agent on your computer.$\r$\n$\r$\n\
     The application bundles everything it needs:$\r$\n\
     🐍  Python Backend — whisper ASR + speaker diarization$\r$\n\
     ⚡  Node.js Runtime v20 LTS — bridge + agent runner$\r$\n\
     🌉  Bridge Server — REST API gateway$\r$\n\
     🤖  Agent Runner — LLM pipeline orchestrator$\r$\n$\r$\n\
     Installation size: approximately 400 MB."
  Pop $WelcomeText

  ${NSD_CreateCheckbox} 0 -30u 100% 14u "Launch Transcription Agent after installation"
  Pop $WelcomeLaunchCheckbox
  ${NSD_Check} $WelcomeLaunchCheckbox

  nsDialogs::Show

  ${NSD_GetState} $WelcomeLaunchCheckbox $RunAfterInstall
FunctionEnd

; ── Progress Detail Messages ──
;
; These are called during the install process by electron-builder's
; generated sections. They show the user what's being installed.

!macro InstallProgressMessages
  DetailPrint ""
  DetailPrint "╔══════════════════════════════════════════════════════════╗"
  DetailPrint "║   🎙️  Transcription Agent — Installing                    ║"
  DetailPrint "╚══════════════════════════════════════════════════════════╝"
  DetailPrint ""

  ; electron-builder extracts all files (core + extraResources) here.
  ; We add branded messages for each major component as they're being
  ; extracted by the generated sections.

  DetailPrint "📦 Copying application files..."
!macroend

!macro PythonBackendMessage
  DetailPrint ""
  DetailPrint "🐍  Python Backend"
  DetailPrint "    • Whisper ASR engine (speech-to-text)"
  DetailPrint "    • Speaker diarization (who spoke when)"
  DetailPrint "    • Voiceprint matching"
  DetailPrint "    • Semantic & ephemeral memory"
  DetailPrint "    • Size: ~200 MB (standalone binary)"
!macroend

!macro NodeJsMessage
  DetailPrint ""
  DetailPrint "⚡  Node.js Runtime"
  DetailPrint "    • Version 20 LTS"
  DetailPrint "    • Used by: Bridge Server & Agent Runner"
  DetailPrint "    • Size: ~50 MB"
!macroend

!macro BridgeServerMessage
  DetailPrint ""
  DetailPrint "🌉  Bridge Server"
  DetailPrint "    • REST API gateway"
  DetailPrint "    • Proxies requests between UI and Python backend"
  DetailPrint "    • Manages agent configuration"
!macroend

!macro AgentRunnerMessage
  DetailPrint ""
  DetailPrint "🤖  Agent Runner"
  DetailPrint "    • LLM pipeline orchestrator"
  DetailPrint "    • Transcript refinement, summarization, analysis"
  DetailPrint "    • Memory persistence (ChromaDB + SQLite)"
  DetailPrint "    • Delivery channel integration"
!macroend

!macro InstallCompleteMessage
  DetailPrint ""
  DetailPrint "╔══════════════════════════════════════════════════════════╗"
  DetailPrint "║   ✅  Installation Complete!                             ║"
  DetailPrint "╠══════════════════════════════════════════════════════════╣"
  DetailPrint "║                                                          ║"
  DetailPrint "║   📍  Installed to: $INSTDIR             ║"
  DetailPrint "║                                                          ║"
  DetailPrint "║   🐍  Python Backend  — bundled           ✅            ║"
  DetailPrint "║   ⚡  Node.js Runtime — bundled           ✅            ║"
  DetailPrint "║   🌉  Bridge Server   — bundled           ✅            ║"
  DetailPrint "║   🤖  Agent Runner    — bundled           ✅            ║"
  DetailPrint "║                                                          ║"
  DetailPrint "║   🚀  Launch the app to start first-time setup           ║"
  DetailPrint "╚══════════════════════════════════════════════════════════╝"
  DetailPrint ""
!macroend

; ── Uninstall Messages ──

!macro UninstallProgressMessages
  DetailPrint ""
  DetailPrint "🗑️  Uninstalling Transcription Agent..."
  DetailPrint "    • Removing application files"
  DetailPrint "    • Cleaning up user data (optional)"
  DetailPrint "    • Removing Ollama (if auto-installed)"
  DetailPrint ""
!macroend

!macro UninstallCompleteMessage
  DetailPrint ""
  DetailPrint "✅  Uninstall complete."
  DetailPrint ""
!macroend

;;
;; ── Cleanup macros (merged from cleanup.nsh) ──
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
;; The uninstall section is included by electron-builder's generated
;; NSIS uninstaller code. These macros handle cleanup beyond what
;; electron-builder's deleteAppDataOnUninstall provides.
;;
;; Usage from electron-builder's default uninstall section:
;;   !insertmacro removeUserData
;;   !insertmacro removeOllamaIfAutoInstalled
;;
