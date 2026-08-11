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

; ── Override electron-builder's "app is running" check ──
; electron-builder 26 (0.7.5+) treats ANY process whose executable path lives
; under $INSTDIR as "the app running" (PowerShell Get-CimInstance Win32_Process,
; Path StartsWith $INSTDIR). This app's bundled Python backend (main.exe) and
; Node (node.exe) run from $INSTDIR\resources\..., so a leftover backend from a
; previous run makes the installer show "Transcription Agent cannot be closed.
; Please close it manually and click Retry to continue" even though the UI isn't
; running (regression introduced with the electron-builder 25→26 upgrade).
; The default kill step only targets "${APP_EXECUTABLE_FILENAME}" by image name,
; so it misses the backend. Override with a kill-by-PID sweep that actually
; closes every process running from the install directory.
!macro customCheckAppRunning
  ; Kill the UI if it's running.
  nsExec::Exec `taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T /F`
  Pop $0
  ; Kill any process running from the install dir (backend main.exe / node.exe)
  ; by PID so the installer is never blocked by a leftover backend.
  nsExec::Exec `"$PowerShellPath" -NoProfile -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
  Pop $0
  Sleep 300
!macroend

; ── Branding ──

BrandingText "Transcription Agent Installer"

; ── Show details view by default ──

ShowInstDetails show

; ── Keep the Cancel button enabled during file extraction ──
;
; NSIS disables the Cancel button on the instfiles (extraction) page by
; default. Defining functions named instfiles.pre / instfiles.show makes NSIS
; call them automatically (Page instfiles resolves <page>.<callback> by name),
; which re-enables Cancel so a ~400 MB install can be aborted mid-way.
; Re-running the installer repairs any partial extraction.
;
; NOTE: guarded with !ifndef BUILD_UNINSTALLER — electron-builder injects this
; include into the shared script header compiled for BOTH the installer and the
; (intermediate) uninstaller, and runs makensis with -WX (warnings as errors).
; The uninstaller has no "instfiles" page (only "uninstfiles"), so these
; functions would otherwise be "not referenced" (NSIS warning 6010) → fatal.

!ifndef BUILD_UNINSTALLER
Function instfiles.pre
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 1
FunctionEnd

Function instfiles.show
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 1
FunctionEnd
!endif

; ── Custom Welcome Page (installer only) ──

!ifndef BUILD_UNINSTALLER

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
     ⚡  Node.js Runtime — via Electron (embedded)$\r$\n\
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

!endif

; ── Custom Install Progress Page (before file extraction) ──

!ifndef BUILD_UNINSTALLER

!macro customPageAfterChangeDir
  Page custom instProgressPage instProgressLeave
!macroend

Var ProgressDialog
Var ProgressTitle
Var ProgressComponents
Var ProgressStatus

Function instProgressPage
  nsDialogs::Create 1018
  Pop $ProgressDialog

  ${If} $ProgressDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 30u "Preparing to Install..."
  Pop $ProgressTitle
  CreateFont $1 "MS Shell Dlg 2" 14 700
  SendMessage $ProgressTitle ${WM_SETFONT} $1 1

  ${NSD_CreateLabel} 0 36u 100% -36u \
    "Transcription Agent will be installed to:$\r$\n\
     $INSTDIR$\r$\n$\r$\n\
     The following components will be installed:$\r$\n\
     🐍  Python Backend — Whisper ASR + speaker diarization$\r$\n\
     ⚡  Node.js Runtime — via Electron (embedded)$\r$\n\
     🌉  Bridge Server — REST API gateway$\r$\n\
     🤖  Agent Runner — LLM pipeline orchestrator$\r$\n$\r$\n\
     Total size: approximately 400 MB."
  Pop $ProgressComponents

  ${NSD_CreateLabel} 0 -30u 100% 14u "Click Install to begin."
  Pop $ProgressStatus

  nsDialogs::Show
FunctionEnd

; Leave callback — runs when the user clicks "Install" on the summary page.
; If an existing installation is present this is an upgrade/overwrite, so
; confirm before extraction begins (user data is always kept). Abort returns
; the user to the summary page, where Cancel is still available.
Function instProgressLeave
  IfFileExists "$INSTDIR\Uninstall Transcription Agent.exe" installed done
  installed:
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
      "Transcription Agent is already installed.$\r$\n$\r$\n\
       Setup will update the existing installation.$\r$\n\
       Your transcripts, voiceprints, and settings will be kept.$\r$\n$\r$\n\
       Continue?" /SD IDYES IDYES done
    Abort
  done:
FunctionEnd

!endif

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
  DetailPrint "    • Runs via Electron's embedded Node (no separate binary)"
  DetailPrint "    • Used by: Bridge Server & Agent Runner"
  DetailPrint "    • Size: 0 MB (embedded in Electron)"
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
  DetailPrint "║   ⚡  Node.js Runtime — via Electron     ✅            ║"
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
  DetailPrint "    • Removing application files from $INSTDIR"
  DetailPrint "    • Cleaning up user data (optional)"
  DetailPrint "    • Removing Ollama (if auto-installed)"
  DetailPrint "    • Removing install directory"
  DetailPrint ""
!macroend

!macro UninstallCompleteMessage
  DetailPrint ""
  DetailPrint "✅  Uninstall complete."
  DetailPrint ""
!macroend

;;
;; ── Cleanup macros (imported from cleanup.nsh) ──
;;

!include "cleanup.nsh"

;;
;; ── Uninstaller wiring ──
;;
;; electron-builder auto-invokes customUnInstall / customUnWelcomePage from its
;; generated uninstaller. We use those hooks to:
;;   1. Kill the running app + orphaned backend children (child-pids.txt)
;;   2. Remove Ollama if it was auto-installed by this app (sentinel-gated)
;;   3. Remove user data only if the user opted in on the uninstall welcome page
;;
;; The removeUserData / removeInstallDir macros in cleanup.nsh are intentionally
;; NOT wired here — electron-builder's own uninstall section already removes
;; $INSTDIR, and app-data removal is controlled by the checkbox below.
;;

!ifdef BUILD_UNINSTALLER

Var UnWelcomeDialog
Var UnWelcomeText
Var DeleteUserDataCheckbox
Var DeleteUserDataChoice

!macro customUnWelcomePage
  Page custom unWelcomePage
!macroend

Function unWelcomePage
  nsDialogs::Create 1018
  Pop $UnWelcomeDialog

  ${If} $UnWelcomeDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 32u "Uninstall Transcription Agent"
  Pop $UnWelcomeText
  CreateFont $1 "MS Shell Dlg 2" 16 700
  SendMessage $UnWelcomeText ${WM_SETFONT} $1 1

  ${NSD_CreateLabel} 0 40u 100% 70u \
    "This will remove Transcription Agent from your computer.$\r$\n$\r$\n\
     Removed components:$\r$\n\
     • Application files from $INSTDIR$\r$\n\
     • Ollama (if it was auto-installed by this app)$\r$\n$\r$\n\
     Your transcripts, voiceprints, and settings are kept unless you choose \
     to delete them below."
  Pop $UnWelcomeText

  ${NSD_CreateCheckbox} 0 -44u 100% 14u "Also delete my transcription data and settings (transcripts, voiceprints, config)"
  Pop $DeleteUserDataCheckbox
  ; Default: PARTIAL uninstall — app files are always removed, but the user's
  ; transcripts, voiceprints, and settings are kept unless they opt in below.
  ${NSD_Uncheck} $DeleteUserDataCheckbox

  nsDialogs::Show

  ${NSD_GetState} $DeleteUserDataCheckbox $DeleteUserDataChoice
FunctionEnd

!macro customUnInstall
  ; Use the CURRENT user's app data — per-machine installs run the uninstaller
  ; elevated, where $APPDATA would otherwise resolve to the admin account.
  SetShellVarContext current

  ; ── 1. Stop the running app + any orphaned backend processes ──
  ; The assisted uninstaller only checks the app exe name, and silent (/S)
  ; uninstalls skip that check entirely. Backend children (python main.exe,
  ; bundled node.exe) otherwise keep userData DB/WAL files locked, making the
  ; RMDir below fail and leaving orphaned data behind.
  nsExec::Exec 'taskkill /IM "Transcription Agent.exe" /T /F'
  Pop $0

  ; Kill any orphaned backend processes recorded in child-pids.txt (written by
  ; the app on service start/stop). Killing by PID is precise — node.exe is too
  ; generic to kill by image name.
  ClearErrors
  FileOpen $0 "$APPDATA\Transcription Agent\child-pids.txt" r
  ${IfNot} ${Errors}
    FileRead $0 $1
    FileClose $0
    StrCpy $3 ""
    StrLen $4 $1
    StrCpy $5 0
    ${DoWhile} $5 < $4
      StrCpy $2 $1 1 $5
      ${If} $2 == ","
        ${If} $3 != ""
          nsExec::Exec 'taskkill /F /PID $3 /T'
          Pop $0
          StrCpy $3 ""
        ${EndIf}
      ${ElseIf} $2 == "$\r"
      ${ElseIf} $2 == "$\n"
        ${If} $3 != ""
          nsExec::Exec 'taskkill /F /PID $3 /T'
          Pop $0
          StrCpy $3 ""
        ${EndIf}
      ${Else}
        StrCpy $3 "$3$2"
      ${EndIf}
      IntOp $5 $5 + 1
    ${Loop}
  ${EndIf}

  ; ── 2. Remove Ollama if it was auto-installed by this app (sentinel-gated) ──
  !insertmacro removeOllamaIfAutoInstalled

  ; ── 3. Remove user data only if the user opted in (default: checked) ──
  ; In silent (/S) mode no page is shown, so $DeleteUserDataChoice is empty and
  ; data is kept unless --delete-app-data is passed (electron-builder handles
  ; that flag itself).
  ${If} $DeleteUserDataChoice == "1"
    RMDir /r "$APPDATA\Transcription Agent"
  ${EndIf}

  SetShellVarContext all
!macroend

!endif
