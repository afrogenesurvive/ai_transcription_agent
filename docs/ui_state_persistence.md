# UI State Persistence (`userData/ui-state.json`)

## Overview

The app remembers panel tabs, subtabs, filters, selections, and the New-form draft across app restarts so users don't have to re-navigate to where they left off. This persisted **UI state** lives in a dedicated file (`ui-state.json`) next to the app's configuration in the platform's per-user application-data directory, deliberately **separate** from it. It is written by the renderer and managed by a tiny main-process module + two IPC channels.

---

## Why not `config.json`?

`config.json` (see `electron/src/main/config.ts`) is the wrong vehicle for high-frequency UI state for four reasons:

1. **`config:save` restarts the agent runner.** The `config:save` IPC handler calls `saveConfig()` and then unconditionally restarts the agent runner (and possibly the Python backend). Tab switches and selection changes happen constantly — they must never bounce the agent runner.
2. **Flat, string-only, `DEFAULTS`-filtered schema.** `AppConfig` is ~60 flat `string` fields, and `parseUserConfig()` drops any key not in the hardcoded `DEFAULTS`. UI state is nested JSON (selected job id, results tab + sub-tab, DB table, TOC page…), which doesn't fit.
3. **Export/import contamination.** `config:export` dumps the raw `config.json` and `config:import` coerces everything to strings. A selected `job_id` or TOC index is meaningless on another machine and shouldn't travel with a config backup.
4. **Restore-defaults / clear clobbering.** `restoreUserConfigDefaults()` and `clearConfig()` wipe `config.json` — they must not wipe UI preferences.

So UI state has its own file and its own IPC channel. `config.json` remains purely configuration; `ui-state.json` is purely view state.

---

## Write model

The **renderer is the single writer**:

1. On mount, `UiStateProvider` loads the whole object once via `ui-state:get`.
2. Components mutate the in-memory object through `useUiStateValue(path, value)`.
3. Writes are flushed to disk via `ui-state:save` on a **~400ms debounce**, plus an immediate flush on `beforeunload` so debounced writes are never lost when the window closes.

There is deliberately **no merge/clear on the main side** — a stale renderer copy can never resurrect a cleared scope. Resets (e.g. clearing the `current` scope when there's no active job) are done renderer-side by deleting the scope from the in-memory object and letting the debounced save persist it.

The file is written atomically (`.tmp` + rename), mirroring `config.ts`.

---

## IPC surface

Main process (`electron/src/main/index.ts`):

| Channel | Payload | Description |
| --- | --- | --- |
| `ui-state:get` | — | Returns the full state object (or `{}` if missing/corrupt). |
| `ui-state:save` | full state object | Replaces the whole file. Returns `false` (and logs a warning) if the payload isn't an object. |

Preload (`electron/src/main/preload.ts`) exposes:

- `getUiState(): Promise<Record<string, any>>`
- `saveUiState(state): Promise<boolean>`
- `getPathForFile(file): string` — returns the absolute filesystem path of a renderer `File` object (via `webUtils.getPathForFile`). Used to persist the New form's selected audio file.

---

## Renderer API (`electron/src/renderer/hooks/useUiState.tsx`)

- **`<UiStateProvider>`** — wraps the app (in `main.tsx`). Loads state on mount, migrates legacy `localStorage` keys, provides the context.
- **`useUiState()`** — returns `{ state, ready, get, set, clearScope }`. `ready` is `true` once the persisted state has finished loading (reset rules must gate on it). `clearScope("current")` deletes a top-level scope.
- **`useUiStateValue(path, fallback)`** — useState-like binding to a dotted path:

  ```tsx
  const [tab, setTab] = useUiStateValue("dev.tab", "live");
  ```

  The setter accepts a plain value **or an updater function** (like `useState`), so `setCollapsed((v) => !v)` works.

### Adding a new persisted state

1. Pick a top-level scope + dotted path, e.g. `dev.myPanel.mySetting`.
2. Bind it in the component: `const [x, setX] = useUiStateValue("dev.myPanel.mySetting", defaultValue);`
3. Add a reset rule in `App.tsx` if it should clear on a lifecycle event (no current job, job deleted, form submitted, etc.).
4. No schema registration needed — the store is open-ended JSON.

---

## State schema

Top-level scopes map to panels. All paths below are persisted; missing keys fall back to the defaults shown.

| Scope | Path | Meaning | Default |
| --- | --- | --- | --- |
| `current` | `current.liveLogExpanded` | Mini live-log expand/collapse | `false` (expanded) |
| `current` | `current.resultsTab` | Live results tab | `"pipeline"` |
| `current` | `current.resultsDevSubTab` | Live results Developer sub-tab | `"tokens"` |
| `history` | `history.leftColCollapsed` | History job-list sidebar collapsed | `false` |
| `history` | `history.selectedJobId` | Selected history job | `null` |
| `history` | `history.resultsTab` | History results tab (persists across selected jobs) | `"pipeline"` |
| `history` | `history.resultsDevSubTab` | History results Developer sub-tab | `"tokens"` |
| `storage` | `storage.tab` | Storage panel tab (`usage`/`developer`) | `"usage"` |
| `dev` | `dev.tab` | Dev panel main tab | `"live"` |
| `dev` | `dev.liveLog.sourceFilter` | Live-log source filter | `"all"` |
| `dev` | `dev.liveLog.levelFilter` | Live-log level filter | `"all"` |
| `dev` | `dev.liveLog.subSourceFilter` | Live-log sub-source filter | `"all"` |
| `dev` | `dev.liveLog.searchQuery` | Live-log search query | `""` |
| `dev` | `dev.liveLog.autoScroll` | Live-log auto-scroll | `true` |
| `dev` | `dev.database.view` | Database view (`ephemeral`/`semantic`/`voiceprints`) | `"ephemeral"` |
| `dev` | `dev.database.table` | Selected ephemeral table | `null` |
| `dev` | `dev.logfiles.jobId` | Log-files selected job | `null` |
| `dev` | `dev.logfiles.subTab` | Log-files view (`pipeline`/`agent`/`transcript`/`raw`) | `"pipeline"` |
| `dev` | `dev.logfiles.sourceFilter` / `.levelFilter` / `.subSourceFilter` | Log-files filters | `"all"` |
| `dev` | `dev.logfiles.searchQuery` | Log-files search query | `""` |
| `dev` | `dev.testing.subTab` | Testing sub-tab (`frontend`/`backend`/`logs`) | `"backend"` |
| `dev` | `dev.guide.doc` | Dev guide selected doc | first doc |
| `dev` | `dev.guide.tocIndex` | Dev guide TOC page | `0` |
| `config` | `config.tab` | Config panel tab (`config`/`agent`/`logging`/`ui`) | `"config"` |
| `config` | `config.section` | Config section | `"LLM Provider"` |
| `config` | `config.agentSubTab` | Agent-instructions sub-tab (`pipeline-steps`/`system-prompt`/`pipeline-hints`/`pipeline-constants`/`defaults`) | `"pipeline-steps"` |
| `about` | `about.tab` | About tab (`about`/`guide`) | `"about"` |
| `about` | `about.guideTocIndex` | About guide TOC page | `0` |
| `newForm` | `newForm.title` | New-form meeting title draft | `""` |
| `newForm` | `newForm.attendees` | New-form attendee list (`[{name, email}]`) | `[]` |
| `newForm` | `newForm.file` | Remembered file `{path, name}` | `null` |
| `newForm` | `newForm.tab` | New Job panel tab (`upload`/`recording`/`meetings`) | `"upload"` |
| `newForm` | `newForm.meetings.provider` | Teams/Zoom provider (`teams`/`zoom`) | `"teams"` |
| `newForm` | `newForm.recording.source` | System-recording capture source id | `""` (first source) |

> **Clear-on-submit:** the whole `newForm` scope (including `newForm.tab`,
> `newForm.meetings.provider`, `newForm.recording.source`) is cleared by
> `App.tsx`'s `clearScope("newForm")` after every successful job submit (rule 8b),
> so the New Job panel always reopens on the Upload tab with a fresh form.

---

## Reset rules

Lifecycle rules live in `electron/src/renderer/App.tsx`:

- **No current job → clear `current`.** When `jobId` becomes `null` (app start with no job, `handleNew`, storage cleared, job deleted), the whole `current` scope is cleared so a stale results tab / live-log collapse doesn't survive into the next session. Gated on the store's `ready` flag so it runs *after* the persisted state loads.
- **History selection survives new-job & panel switches (rule 3b).** `handleNew` and the sidebar Current/History buttons no longer clear `historyJobId` — the selected history job and its loaded data persist, so returning to History shows the same job. History only *renders* while open (`showHistory && historyJobId`), so a preserved-but-closed selection never leaks into the Current view; the live results/processing placeholders gate on `showHistory` rather than the selection.
- **History selection validated on launch.** The persisted `history.selectedJobId` is checked against the actual job list (`api.getHistory()`); if the job no longer exists, the selection **and** the history results tab/sub-tab are reset (rule 3d). The history `ResultsViewer` only renders when History is open (`showHistory && historyJobId`), so a restored-but-not-open selection can't leak into the Current view.
- **New form cleared on job start.** `handleUpload` / `handleUploadByPath` clear the `newForm` scope so a draft doesn't carry into the next meeting.

**Developer-section access is intentionally NOT persisted.** The dev-access warning gate still uses `sessionStorage` (`dev_warning_accepted`) and resets every launch. Only the Dev panel's *internal* state (tabs, filters, etc.) persists.

---

## Legacy migration

One-time migration from the previous `localStorage` keys runs inside `UiStateProvider` right after the initial load (only if the target path is unset, then the legacy key is removed):

| Legacy `localStorage` key | New path |
| --- | --- |
| `historyLeftColCollapsed` | `history.leftColCollapsed` |
| `devpanel:sourceFilter` | `dev.liveLog.sourceFilter` |
| `devpanel:levelFilter` | `dev.liveLog.levelFilter` |
| `devpanel:autoScroll` | `dev.liveLog.autoScroll` |

The UploadPanel attendee-autocomplete suggestions intentionally remain in `localStorage` (`transcription_agent_saved_attendees`) — that's a separate convenience feature, not panel state.

---

## New-form file persistence

The New form distinguishes the **live `File`** (current session) from the **remembered path** (restart restore):

1. **Live `File` (authoritative for the current session).** The selected audio `File` is hoisted to App state (`App.tsx` `formFile`) and passed into `UploadPanel` as the `file` prop (`onFileChange` lifts pick/clear back up). Because it lives in App (which never unmounts), it **survives panel switches** — switching to the Dev/database view (or History/Storage/Config/About) and back keeps the file, and submit uses the multipart upload with the actual bytes (no path dependency). `handleNew()` deliberately does **not** clear `formFile`, so every return path to the New form (sidebar New button, `PipelineProgress.onNewJob`, foreign-job `onNewJob`) preserves the selected file. The file is cleared only on successful submit (`handleUpload` / `handleUploadByPath`) or the form's Remove / clearForm.
2. **Remembered path (restart-restore only).** A browser `File` object can't be serialized, so on file pick `handleFile` also calls `window.electronAPI.getPathForFile(f)` (`webUtils.getPathForFile`) and stores `{ path, name }` in `newForm.file` (`ui-state.json`). If `getPathForFile` returns no path (file without a real backing path), any stale remembered path is dropped instead of lingering as the fallback/chip.
3. On launch, `newForm.file` restores as a **"remembered file" chip** in the dropzone (`file-info--remembered`). A `fileExists` check drops the chip automatically if the file no longer exists on disk.
4. Submitting with **no live `File`** (i.e. after a restart restore) uses the remembered path through `/transcribe/upload_by_path` (`api.uploadAudioByPath` in `useApi.ts`). Before calling it, `handleSubmit` re-validates the path with `fileExists`; if it's gone, the chip is dropped and the user sees "The remembered audio file no longer exists on disk — please re-select it." instead of a backend 404 "File not found".

---

## Relationship to config operations

- `config:export` / `config:import` — do **not** touch `ui-state.json` (intentionally).
- `config:restore-defaults` / `config:clear` — do **not** touch `ui-state.json`.
- "Clear All Data" (Storage panel) clears job/DB data only — UI state survives.
- To reset all UI preferences manually, delete `ui-state.json` (the app recreates it as `{}` on next launch) **or** use **Config → UI → Clear all UI state**.

---

## Reset UI state (Config → UI tab)

A dedicated **UI** tab in the Config panel exposes a **"Clear all UI state"** button (with a confirmation dialog) that wipes every scope back to defaults — no restart needed:

- `useUiState.tsx` — the provider exposes a `reset()` on the context: it clears the in-memory state to `{}` (so every `useUiStateValue`-bound component immediately re-renders with its default) and persists `{}` immediately. Any pending debounced save is cancelled first so a stale write can't re-persist old state.
- `ConfigPanel.tsx` — the `ui` value was added to the `ConfigTab` union; because `activeTab` is already bound to the persisted `config.tab` key, **the UI tab's own selection is part of UI-state persistence** (it restores across panel close and app restart).
- After clearing, the panel stays on the UI tab and shows a confirmation; `config.json`, storage, and the sessionStorage dev-access gate are untouched.

---

## Implementation notes

- **Module:** `electron/src/main/ui-state.ts` — `getUiState()` / `saveUiState()` (atomic write; returns `{}` on corrupt/unreadable file).
- **Main wiring:** `electron/src/main/index.ts` — `ui-state:get` / `ui-state:save` handlers; `addLog("main", ...)` traces for the Dev log viewer.
- **Preload/types:** `preload.ts` + `renderer/types.d.ts` — the three `ElectronAPI` methods.
- **ResultsViewer:** accepts a `stateScope` prop (`"live"` / `"history"`) that binds tabs to `current.*` or `history.*`. The old per-job tab reset was removed — the component remounts via `key` and re-reads the store, giving "keep last tab across jobs".
- **DocViewer:** accepts `initialIndex` / `onIndexChange` props so each guide (About + Dev) can restore its own TOC page.
