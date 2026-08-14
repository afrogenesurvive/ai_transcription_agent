# Configuration Guide

A comprehensive reference for the Transcription Agent's configuration system — covering all three config layers, file locations, merge priority, IPC operations, import/export, defaults restoration, and data flows.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Layer 1: User Config](#layer-1-user-config)
3. [Layer 2: Agent Config (Agent Instructions)](#layer-2-agent-config-agent-instructions)
4. [Layer 3: Defaults Snapshots](#layer-3-defaults-snapshots)
5. [Data Flow Diagrams](#data-flow-diagrams)
6. [Windows Compatibility](#windows-compatibility)
7. [IPC Reference](#ipc-reference)
8. [Config Key Reference](#config-key-reference)

---

## Architecture Overview

The application has three independent config layers that work together:

```
┌──────────────────────────────────────────────────────────────────┐
│                   CONFIGURATION LAYERS                            │
│                                                                  │
│   ┌──────────────────────────────────────────────┐               │
│   │        LAYER 1: USER CONFIG                   │               │
│   │  ┌──────────────┐  ┌────────────────────┐    │               │
│   │  │ config.json  │  │ config.defaults.json│    │               │
│   │  │ (user edits) │  │ (shipped snapshot)  │    │               │
│   │  └──────┬───────┘  └─────────┬──────────┘    │               │
│   │         │                    │                │               │
│   │         ▼                    ▼                │               │
│   │  ┌──────────────────────────────┐             │               │
│   │  │   getConfig() → AppConfig    │             │               │
│   │  │   merge: userFile > defaults  │             │               │
│   │  └──────────────┬───────────────┘             │               │
│   │                 │ exports to child processes  │               │
│   │                 │ via getChildEnv()           │               │
│   └─────────────────┼────────────────────────────┘               │
│                     │                                            │
│   ┌─────────────────┼────────────────────────────┐               │
│   │   LAYER 2: AGENT CONFIG (agent-config/)      │               │
│   │   ┌──────────┐ ┌────────────┐ ┌────────────┐ │               │
│   │   │tools.json│ │pipeline.json│ │sys-prompt.md│ │               │
│   │   └────┬─────┘ └─────┬──────┘ └─────┬──────┘ │               │
│   │        │              │              │        │               │
│   │        ▼              ▼              ▼        │               │
│   │   ┌─────────────────────────────────────┐     │               │
│   │   │ agent-runner/agent-config.js         │     │               │
│   │   │ (loaded synchronously at import)     │     │               │
│   │   │ FALLBACK_TOOLS / FALLBACK_PIPELINE   │     │               │
│   │   └─────────────────────────────────────┘     │               │
│   └────────────────────────────────────────────────┘               │
│                                                                  │
│   ┌──────────────────────────────────────────────┐               │
│   │   LAYER 3: DEFAULTS SNAPSHOTS                │               │
│   │   userData/                                   │               │
│   │   ├── config.defaults.json   ← restore-user   │               │
│   │   └── agent-config/                           │               │
│   │       └── .defaults/         ← restore-agent  │               │
│   └──────────────────────────────────────────────┘               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: User Config

Controls API keys, LLM provider settings, delivery credentials, appearance, and feature toggles.

### File Locations

| File                                 | Purpose                        | Created                       |
| ------------------------------------ | ------------------------------ | ----------------------------- |
| `{userData}/config.json`             | User-saved overrides           | On first save via ConfigPanel |
| `{userData}/config.defaults.json`    | Shipped-defaults snapshot      | On first Electron launch      |
| `.env` (project root or `userData/`) | Environment variable overrides | Manual setup                  |

**`userData` path resolution:** the platform's standard per-user application-data
directory, resolved at runtime by the app (exact paths are intentionally not
published here).

### Merge Priority (highest → lowest)

If multiple sources define the same key, the highest-priority source wins:

1. **`config.json`** — Explicit user values (non-empty strings)
2. **`process.env`** — From `.env` file or host environment
3. **Hardcoded `DEFAULTS`** — In `electron/src/main/config.ts`

The UI shows source annotations via `getConfigWithSources()`:

- `"user_config"` — value is in `config.json`
- `"environment"` — value is in `process.env`
- `"default"` — value is the hardcoded default

### How It Works

**File:** `electron/src/main/config.ts`

```typescript
interface AppConfig {
  DEEPSEEK_API_KEY: string; // Required for DeepSeek LLM
  LLM_PROVIDER: string; // "deepseek" | "ollama"
  OLLAMA_BASE_URL: string; // Ollama endpoint
  OLLAMA_MODEL: string; // Ollama model name
  OLLAMA_NUM_CTX: string; // Context window: 32768|65536|131072
  GMAIL_CLIENT_ID: string; // Gmail delivery OAuth (via in-app "Connect with Google" or config import)
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_USER: string;
  MS_CLIENT_ID: string; // Teams (Entra) OAuth — via in-app "Connect Microsoft Teams"
  MS_REFRESH_TOKEN: string;
  MS_USER: string;
  ZOOM_CLIENT_ID: string; // Zoom Marketplace OAuth — via in-app "Connect Zoom"
  ZOOM_CLIENT_SECRET: string;
  ZOOM_REFRESH_TOKEN: string;
  ZOOM_USER: string;
  TRELLO_KEY: string; // Trello delivery API key
  TRELLO_TOKEN: string;
  HUGGING_FACE_TOKEN: string; // For gated PyAnnote models
  GITHUB_TOKEN: string; // Private repo auto-updates
  EMBEDDING_PROVIDER: string; // "pyannote" | "speechbrain"
  WHISPER_MODEL_SIZE: string; // "medium" | "large"
  WHISPER_INITIAL_PROMPT_ENABLED: string;
  WHISPER_INITIAL_PROMPT: string;
  KEEP_TRANSCRIPT_TIMESTAMPS: string;
  LOG_LLM_DATA: string; // Debug logging toggle
  LOG_COLLAPSE_REPEATED_PREFIXES: string;
  LOG_CHROMIUM: string; // Route Chromium renderer/GPU logs to stderr (--enable-logging)
  LLM_TEMPERATURE: string; // 0.0–2.0
  PIPELINE_TIMEOUT_MINUTES: string;
  GATE_RAW_REVIEW_ENABLED: string;
  GATE_DELIVERY_REVIEW_ENABLED: string;
  KEEP_MODELS_WARM: string;
  DELIVERY_RECIPIENT_EMAILS: string;
  DELIVERY_EMAIL_SUBJECT: string;
  DELIVERY_EMAIL_ADDITIONAL_CONTENT: string;
  DELIVERY_DRIVE_FOLDER: string;
  APPEARANCE_THEME: string; // "dark" | "light"
  APPEARANCE_ACCENT_COLOR: string;
  APPEARANCE_FONT_SIZE: string; // "small" | "medium" | "large"
  APPEARANCE_SIDEBAR_WIDTH: string;
  PERF_METRICS_POLL_INTERVAL: string;
  CREDIT_POLL_INTERVAL: string;
  PLAYWRIGHT_AUDIO_FILE_PATH: string; // Test-only
  PLAYWRIGHT_TITLE_TEMPLATE: string;
  PLAYWRIGHT_GENERIC_NAMES: string;
}
```

### Key Operations

| Action                 | IPC Channel               | Code Path                     | What Happens                                                                                                                                                                  |
| ---------------------- | ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read**               | `config:get`              | `getConfig()`                 | Merges `config.json` → defaults, returns `AppConfig`                                                                                                                          |
| **Read with sources**  | `config:getWithSources`   | `getConfigWithSources()`      | Same as above, but annotates each key with its source                                                                                                                         |
| **Save**               | `config:save`             | `saveConfig(values)`          | Merges partial values into `config.json`, strips empty keys, invalidates cache. Restarts agent runner; also restarts the Python backend when any Python-consumed key changes. |
| **Clear**              | `config:clear`            | `clearConfig()`               | Writes `{}` to `config.json` (all values → defaults). **Guard:** blocks if active jobs. Restarts agent runner + Python backend.                                               |
| **Restore defaults**   | `config:restore-defaults` | `restoreUserConfigDefaults()` | Copies `config.defaults.json` over `config.json`. **Guard:** blocks if active jobs. Restarts agent runner + Python backend.                                                   |
| **Check completeness** | `config:check`            | `checkConfig()`               | Returns `{ok, missing[]}`. If LLM_PROVIDER=ollama, DEEPSEEK_API_KEY is not required.                                                                                          |

### Child Process Environment

`getChildEnv()` in `config.ts` exports all config values to child processes (Python backend, bridge, agent runner). In **packaged (production)** mode, it also overrides storage paths to point inside `userData/`:

```typescript
// Only in app.isPackaged === true:
TRANSCRIPTION_STORAGE    → {userData}/storage
TRANSCRIPTION_QUEUE_DIR  → {userData}/queue
TRANSCRIPTION_TRIGGER_FILE → {userData}/queue/.transcription-trigger
```

> **Note:** `TRANSCRIPTION_QUEUE_DIR` now only stores the trigger file (`.transcription-trigger`). The event queue data itself lives in the `events` table of `{userData}/storage/ephemeral_memory.db`, which is the SQLite database shared by the Python backend and agent runner. This migration from JSONL to SQLite happened in 0.4.10.

In **development** mode, child processes use project-relative paths (`./storage/`, `./queue/`).

`getChildEnv()` applies **`user config → process.env → DEFAULT`** precedence for every key: an explicit value in `config.json` wins; otherwise a `.env`/host env var wins; otherwise the hardcoded default. All `AppConfig` keys are forwarded to child processes, including `OLLAMA_NUM_CTX` (agent-runner context window), `PERF_METRICS_POLL_INTERVAL`/`CREDIT_POLL_INTERVAL` (renderer poll rates), and `LOG_COLLAPSE_REPEATED_PREFIXES`. `APP_VERSION` is always injected so children (e.g. the bridge's defaults snapshot) know the running app version.

---

## Layer 2: Agent Config (Agent Instructions)

Controls the LLM's tool definitions, pipeline step ordering, system prompt, and runtime constants.

### File Locations

| File (committed)                         | → Live File (gitignored)        | Runtime Location                           |
| ---------------------------------------- | ------------------------------- | ------------------------------------------ |
| `agent-config/pipeline.template.json`    | `agent-config/pipeline.json`    | `{userData}/agent-config/pipeline.json`    |
| `agent-config/tools.template.json`       | `agent-config/tools.json`       | `{userData}/agent-config/tools.json`       |
| `agent-config/system-prompt.template.md` | `agent-config/system-prompt.md` | `{userData}/agent-config/system-prompt.md` |
| `agent-config/.defaults/*` (committed)   | — (shipped defaults)            | `{userData}/agent-config/.defaults/*`      |
| `agent-config/schema.json`               | — (validation schema)           | —                                          |

### Initialization Flow

On first Electron launch, `initAgentConfigDir()` in `backend-manager.ts`:

1. Checks if `{userData}/agent-config/` exists
2. If not, looks for bundled source in `extraResources/agent-config/`
3. Copies live files (`.json`, `.md`) or falls back to `.template.*` files
4. Seeds `{userData}/agent-config/.defaults/` from the bundled `.defaults/` (or from live files if no bundled snapshot exists), stamping `version.json`
5. On later launches, if `{userData}/agent-config/.defaults/version.json` differs from the running app version, refreshes `.defaults/` from the bundled snapshot (new defaults after an upgrade)

### What Each File Contains

#### `tools.json`

Array of tool definitions in OpenAI function-calling format:

```json
[
  {
    "name": "transcribe_refine",
    "description": "Clean a transcript...",
    "terminal": false,
    "handler": "bridge",
    "inputSchema": {
      "type": "object",
      "properties": { "jobId": { "type": "string" } },
      "required": ["jobId"]
    }
  }
]
```

Validated against `schema.json` (enforced by the ConfigPanel before saving):

- `name`: lowercase with underscores (`^[a-z_]+$`)
- `handler`: `"bridge"` (proxies to Python) or `"direct"` (external API)
- `terminal`: if `true`, calling this tool ends the pipeline
- `inputSchema`: JSON Schema for arguments

#### `pipeline.json`

Contains pipeline configuration:

| Key                          | Type     | Description                                          |
| ---------------------------- | -------- | ---------------------------------------------------- |
| `max_pipeline_steps`         | number   | Max iterations before forced stop (default: 40)      |
| `max_retries`                | number   | LLM call retry count (default: 6)                    |
| `retry_base_delay_ms`        | number   | Exponential backoff base (default: 4000)             |
| `ollama_max_retries`         | number   | Ollama-specific retry count (default: 5)             |
| `ollama_retry_base_delay_ms` | number   | Ollama-specific backoff base (default: 5000)         |
| `llm_context_window`         | number   | Step result blocks kept (0 = all)                    |
| `terminal_tools`             | string[] | Tools that end the pipeline                          |
| `pipeline_steps`             | array    | Ordered step definitions with enabled/disabled state |
| `pipeline_hints`             | object   | Step-to-step guidance for the LLM                    |
| `event_templates`            | object   | Message templates for job lifecycle events           |

Each **pipeline step** has:

- `id` — `"step-N"` pattern
- `toolName` — References a tool in `tools.json`
- `label` — Human-readable name (max 100 chars)
- `description` — Short description (max 200 chars)
- `systemPromptTemplate` — Per-step prompt override (max 500 chars)
- `hintTemplate` — Hint shown to LLM after step executes (max 500 chars)
- `enabled` — Whether the step is active
- `isTerminal` — Whether this step ends the pipeline.

#### `system-prompt.md`

The LLM system prompt template. Contains a `{{TOOL_LIST}}` placeholder that the agent runner replaces with the actual tool definitions at runtime.

#### `schema.json`

JSON Schema (draft-07) that validates `tools.json` (array of tool definitions) and `pipeline.json` (constants/steps/hints/event templates). A root `oneOf` selects between the two file shapes. The ConfigPanel validates the pipeline (and tool definitions) against this schema **before saving** — a malformed config is rejected with an inline error instead of being written to disk. A TS copy lives at `electron/src/renderer/utils/agentConfigSchema.ts` — keep the two files in sync when editing either one.

### Agent Runner Loading

**File:** `agent-runner/agent-config.js`

All config files are read **synchronously** at import time for a consistent snapshot:

- No hot-reload — a runner restart is required to pick up changes
- Restart is triggered by writing `{userData}/agent-config/.restart-flag`

**Config directory resolution** (tried in order):

1. `agent-runner/../agent-config/`
2. `agent-runner/../../agent-config/`
3. `agent-runner/agent-config/`

**Fallback strategy (three layers):**

1. **Live file** in the resolved config dir (e.g. `{userData}/agent-config/tools.json`)
2. **Shipped defaults snapshot** at `{configDir}/.defaults/<file>` (seeded by `initAgentConfigDir()` and refreshed on app upgrades) — used when the live file is missing or fails to parse
3. **Hardcoded `FALLBACK_TOOLS` / `FALLBACK_PIPELINE` / `FALLBACK_SYSTEM_PROMPT`** — a last-resort set that mirrors the shipped templates and always loads

The layered fallback means a corrupt live file (e.g. a bad edit) no longer drops the runner onto a stale hardcoded set — it loads the shipped defaults instead.

### Bridge REST API (port 5010)

The bridge server exposes CRUD endpoints for agent config management:

| Endpoint                         | Method | Purpose                                                                 | Guard                                |
| -------------------------------- | ------ | ----------------------------------------------------------------------- | ------------------------------------ |
| `/agent/config`                  | GET    | Returns live `{tools, pipeline, systemPrompt}` from disk                | —                                    |
| `/agent/config`                  | POST   | Writes tools/pipeline/systemPrompt files (atomic rename: `.tmp` → file) | ❌ Blocks if active ML pipeline jobs |
| `/agent/config/restart`          | POST   | Touches `{userData}/agent-config/.restart-flag`                         | —                                    |
| `/agent/config/defaults`         | GET    | Returns shipped defaults from `{userData}/agent-config/.defaults/`      | —                                    |
| `/agent/config/defaults`         | POST   | Writes to `{userData}/agent-config/.defaults/` (used during import)     | —                                    |
| `/agent/config/restore-defaults` | POST   | Copies `.defaults/*` over live config files, touches restart flag       | —                                    |

### Save Mechanism (Dual-Path)

Every agent-config save from the Electron main process uses a dual-path strategy:

1. **Primary:** POST to bridge server (`http://127.0.0.1:5010/agent/config`)
   - Bridge writes files atomically, touches `.restart-flag`
2. **Fallback:** Direct disk write via `saveAgentConfigToDisk()` in `config.ts`
   - Writes directly to `{userData}/agent-config/`
   - Also touches `.restart-flag`

This ensures config changes work even when the bridge is restarting or on a clean install.

---

## Layer 3: Defaults Snapshots

Two independent snapshot systems, one per config layer:

### User Config Defaults

| File                              | Created                                                                                         | Contents                                                                                                                                                                        | Restored By                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `{userData}/config.defaults.json` | `ensureUserConfigDefaults()` on first launch, then regenerated whenever the app version changes | Full `AppConfig` object + an internal `__version` stamp. First launch: hardcoded `DEFAULTS` merged with any existing `config.json` values. On upgrade: pure current `DEFAULTS`. | `config:restore-defaults` IPC |

### Agent Config Defaults

| Directory                            | Created                                                                                                   | Contents                                                                 | Restored By                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `{userData}/agent-config/.defaults/` | `snapshotDefaults()` on bridge startup + refreshed by `initAgentConfigDir()` when the app version changes | `tools.json`, `pipeline.json`, `system-prompt.md` + `version.json` stamp | `agent-config:restore-defaults` IPC → bridge `POST /agent/config/restore-defaults` |

### How Defaults Are Used

**Export** reads both snapshots and includes them in the export file.
**Import** writes both snapshots from the import file, preserving them for future restore operations.
**Restore** copies the snapshot over the live config — this is a destructive, one-way operation.

Both snapshots carry a version stamp. When the app is upgraded to a new version, the snapshots are regenerated from the current shipped defaults, so **Restore defaults always restores the _current_ defaults** rather than the values frozen at install time.

---

## Data Flow Diagrams

### Save User Config

```
ConfigPanel UI
  → window.electronAPI.saveConfig({...})
    → IPC: config:save
      → config.ts::saveConfig()
        → Write {userData}/config.json (merge partial values)
        → Invalidate cache
      → If Ollama provider changed:
          → Start/stop Ollama server
      → Restart agent runner (always)
      → Restart Python backend (only if a Python-consumed key changed, e.g.
        WHISPER_MODEL_SIZE, DIARIZATION_*, DELIVERY_*, GATE_*, KEEP_MODELS_WARM,
        KEEP_TRANSCRIPT_TIMESTAMPS, HUGGING_FACE_TOKEN, EMBEDDING_PROVIDER)
```

### Save Agent Config (Agent Tab)

```
ConfigPanel UI
  → window.electronAPI.saveAgentConfig({tools?, pipeline?, systemPrompt?})
    → IPC: agent-config:save
      → [TRY] fetch POST http://127.0.0.1:5010/agent/config
          → Bridge writes files atomically (.tmp → rename)
          → Bridge touches .restart-flag
          → If bridge returns 409: "Active jobs running" — abort
      → [FALLBACK] saveAgentConfigToDisk()
          → Write {userData}/agent-config/{pipeline,tools}.json + system-prompt.md
          → Touch .restart-flag
    → Electron's fs.watch detects .restart-flag change
      → Restart agent runner (reads new config at import)
```

### Export Config

```
ConfigPanel UI (Export button)
  → window.electronAPI.exportConfig()
    → IPC: config:export
      → Read {userData}/config.json
      → Read {userData}/config.defaults.json
      → [TRY] fetch GET http://127.0.0.1:5010/agent/config
      → [TRY] fetch GET http://127.0.0.1:5010/agent/config/defaults
      → Prompt save dialog
      → Write version-3 JSON:

        {
          "version": 3,
          "exportedAt": "2026-07-21T...",
          "userConfig": { ... },
          "userDefaultsConfig": { ... },
          "agentConfig": { tools, pipeline, systemPrompt },
          "defaultsConfig": { tools, pipeline, systemPrompt }
        }
```

### Import Config

```
ConfigPanel UI (Import button)
  → window.electronAPI.importConfig()
    → IPC: config:import
      → [CHECK] fetch active jobs — block if any are running
      → Open file dialog → read JSON
      → Validate format (must have "version" + "userConfig")
      → Save user config → check completeness
      → Ensure Ollama running/stopped as needed
      → Restart ALL services (Python backend, bridge, agent runner)
      → Import agent config:
          [TRY] POST /agent/config to bridge
          [FALLBACK] saveAgentConfigToDisk()
      → Import user defaults snapshot:
          Write {userData}/config.defaults.json
      → Import agent defaults snapshot:
          [TRY] POST /agent/config/defaults to bridge
          [FALLBACK] Write {userData}/agent-config/.defaults/*
```

### Restore Defaults

```
User Config Restore             Agent Config Restore
      │                               │
      ▼                               ▼
 config:restore-defaults       agent-config:restore-defaults
      │                               │
      ▼                               ▼
 Read config.defaults.json     POST /agent/config/restore-defaults
 Copy over config.json          Copy .defaults/* → live files
 Restart agent runner            Touch .restart-flag
      │                               │
      ▼                               ▼
 electron detects restart      electron fs.watch detects
 and restarts all services     .restart-flag → restart runner
```

---

## Windows Compatibility

The config system is fully Windows-compatible. All cross-platform concerns are handled:

| Area                     | Implementation                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Path construction**    | `path.join()` / `path.resolve()` everywhere — never hardcoded `/` or `\`                             |
| **Process spawning**     | `PYTHON_BIN`: `"python"` on Windows, `"python3"` on Unix. `NODE_BIN`: `"node.exe"` vs `"node"`       |
| **Process termination**  | `SIGTERM` on Unix, `taskkill /PID /T /F` on Windows                                                  |
| **Atomic file writes**   | `.tmp` → `fs.renameSync()` — atomic on both NTFS and APFS                                            |
| **Port detection**       | `netstat -ano \| findstr` on Windows, `lsof` on Unix                                                 |
| **Shell sleep**          | `timeout /t` on Windows, `sleep` on Unix                                                             |
| **Null device**          | `nul` on Windows, `/dev/null` on Unix                                                                |
| **Restart flag watcher** | Polling — checks `agent-config/.restart-flag` every 2s (fs.watch on a non-existent file never fires) |
| **File dialogs**         | Electron `dialog.showSaveDialog` / `showOpenDialog` — cross-platform                                 |
| **ConfigPanel UI**       | Pure React — no platform-specific code                                                               |
| **Bridge server**        | Pure HTTP — no platform-specific code                                                                |
| **Agent runner**         | No platform-specific code                                                                            |

> **Note:** The `.restart-flag` watcher polls every 2s for the flag file (created by the bridge `POST /agent/config/restart` and restore-defaults, or `saveAgentConfigToDisk`) and unlinks it in the poll callback so it can't re-trigger. The timer is cleared on quit.

---

## IPC Reference

### User Config

| Channel                   | Parameters               | Returns                                                                                                              | Guard          |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------- |
| `config:get`              | —                        | `Record<keyof AppConfig, string>`                                                                                    | —              |
| `config:save`             | `Record<string, string>` | `Record<string, string>` (updated)                                                                                   | —              |
| `config:check`            | —                        | `{ok: boolean, missing: string[]}`                                                                                   | —              |
| `config:clear`            | —                        | `{success, error?, blocked?}`                                                                                        | ❌ Active jobs |
| `config:getWithSources`   | —                        | `Record<string, {value, source}>`                                                                                    | —              |
| `config:export`           | —                        | `{success, filePath?, error?, cancelled?}`                                                                           | —              |
| `config:import`           | —                        | `{success, filePath?, error?, cancelled?, blocked?, agentConfigImported?, defaultsImported?, userDefaultsImported?}` | ❌ Active jobs |
| `config:defaults`         | —                        | `{success, defaults}`                                                                                                | —              |
| `config:restore-defaults` | —                        | `{success, error?, blocked?}`                                                                                        | ❌ Active jobs |
| `config:set-defaults`     | —                        | `{success, agentDefaultsSaved?, error?, warnings?}`                                                                  | ❌ Active jobs |

### Agent Config

| Channel                         | Parameters                           | Returns                                      | Guard                          |
| ------------------------------- | ------------------------------------ | -------------------------------------------- | ------------------------------ |
| `agent-config:get`              | —                                    | `{tools?, pipeline?, systemPrompt?, error?}` | —                              |
| `agent-config:save`             | `{tools?, pipeline?, systemPrompt?}` | `{success?, written?, error?}`               | ⚠️ Bridge-side: ❌ Active jobs |
| `agent-config:defaults`         | —                                    | `{tools?, pipeline?, systemPrompt?, error?}` | —                              |
| `agent-config:restore-defaults` | —                                    | `{success?, restored[]?, error?}`            | ❌ Active jobs                 |
| `agent-config:restart`          | —                                    | `{success?, error?}`                         | —                              |

---

## Config Key Reference

### Required Keys

The only required key is `DEEPSEEK_API_KEY` — but only when `LLM_PROVIDER` is `"deepseek"` (the default). If using Ollama, no API key is required, but `OLLAMA_MODEL` must be set — `config:check` reports it as missing otherwise (previously the runner only failed at the first LLM call).

### Default Values Summary

| Key                            | Default                      | Notes                                                                                                                                                                                      |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM_PROVIDER`                 | `"deepseek"`                 | Switch to `"ollama"` for local inference                                                                                                                                                   |
| `OLLAMA_BASE_URL`              | `http://127.0.0.1:11434/v1`  | Ollama's OpenAI-compatible endpoint                                                                                                                                                        |
| `OLLAMA_NUM_CTX`               | `32768`                      | Also valid: `65536`, `131072`                                                                                                                                                              |
| `WHISPER_MODEL_SIZE`           | `"medium"`                   | Or `"large"` for higher accuracy                                                                                                                                                           |
| `EMBEDDING_PROVIDER`           | `"pyannote"`                 | Or `"speechbrain"`                                                                                                                                                                         |
| `LLM_TEMPERATURE`              | `"0.1"`                      | Range: 0.0 (deterministic) – 2.0 (creative)                                                                                                                                                |
| `PIPELINE_TIMEOUT_MINUTES`     | `"60"`                       | Pipeline timeout before forced fail                                                                                                                                                        |
| `APPEARANCE_THEME`             | `"dark"`                     | Or `"light"`                                                                                                                                                                               |
| `APPEARANCE_ACCENT_COLOR`      | `"#58a6ff"`                  | Any valid CSS color                                                                                                                                                                        |
| `APPEARANCE_FONT_SIZE`         | `"medium"`                   | Or `"small"`, `"large"`                                                                                                                                                                    |
| `DELIVERY_EMAIL_SUBJECT`       | `"Meeting Summary: {title}"` | `{title}` is replaced at send time                                                                                                                                                         |
| `DELIVERY_DRIVE_FOLDER`        | `"Meeting Transcripts"`      | Created automatically if missing                                                                                                                                                           |
| `GATE_RAW_REVIEW_ENABLED`      | `"false"`                    | Gate 1: pause after ASR                                                                                                                                                                    |
| `GATE_DELIVERY_REVIEW_ENABLED` | `"false"`                    | Gate 2: pause before delivery                                                                                                                                                              |
| `CUSTOM_DELIVERY_PER_MEETING`  | `"false"`                    | Custom delivery per meeting: pause at Gate 2 to pick which attendees receive the email (implies Gate 2). When off, deliver to all attendees.                                               |
| `DIARIZATION_TIMEOUT_MINUTES`  | `"60"`                       | Floor for the diarization subprocess timeout. The effective budget auto-scales to audio length (default ~2× duration), so this is a minimum. Raise it if long meetings time out at 60 min. |
| `KEEP_MODELS_WARM`             | `"false"`                    | Keep ML models loaded between jobs                                                                                                                                                         |
| `LOG_LLM_DATA`                 | `"false"`                    | Debug logging — writes LLM I/O to disk                                                                                                                                                     |
| `LOG_CHROMIUM`                 | `"true"`                     | Debug — routes Chromium renderer/GPU/console logs to stderr (restart required)                                                                                                             |
| `PERF_METRICS_POLL_INTERVAL`   | `"10000"`                    | Milliseconds                                                                                                                                                                               |
| `CREDIT_POLL_INTERVAL`         | `"60000"`                    | Milliseconds                                                                                                                                                                               |

---

## File Reference

### Source Files

| File                                               | Purpose                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `electron/src/main/config.ts`                      | User config management: DEFAULTS, get/save/clear/export/import/restore, child env |
| `electron/src/main/backend-manager.ts`             | Agent config directory init, path resolution, process management                  |
| `electron/src/main/index.ts`                       | IPC handlers for all config channels, restart-flag watcher, service orchestration |
| `electron/src/main/preload.ts`                     | `contextBridge.exposeInMainWorld("electronAPI", ...)` — all config IPC bindings   |
| `electron/src/renderer/components/ConfigPanel.tsx` | UI: config tab, agent tab, logging tab, export/import/clear/restore buttons       |
| `agent-runner/agent-config.js`                     | Agent config loading: sync file read, fallback defaults, CONFIG_DIR resolution    |
| `bridge-server/index.js`                           | Bridge REST API: agent config CRUD, defaults snapshot, restart flag               |

### Config Data Files

| File                                                 | Layer | Purpose                                                   |
| ---------------------------------------------------- | ----- | --------------------------------------------------------- |
| `{userData}/config.json`                             | 1     | User-saved config values                                  |
| `{userData}/config.defaults.json`                    | 3     | Shipped user-config defaults snapshot                     |
| `{userData}/agent-config/tools.json`                 | 2     | Tool definitions                                          |
| `{userData}/agent-config/pipeline.json`              | 2     | Pipeline steps, hints, constants                          |
| `{userData}/agent-config/system-prompt.md`           | 2     | LLM system prompt template                                |
| `{userData}/agent-config/.defaults/tools.json`       | 3     | Shipped agent-config defaults snapshot                    |
| `{userData}/agent-config/.defaults/pipeline.json`    | 3     | Shipped agent-config defaults snapshot                    |
| `{userData}/agent-config/.defaults/system-prompt.md` | 3     | Shipped agent-config defaults snapshot                    |
| `{userData}/agent-config/.restart-flag`              | —     | Signal file watched by Electron → triggers runner restart |
| `agent-config/schema.json`                           | —     | Validation schema (source of truth)                       |
| `agent-config/*.template.*`                          | —     | Committed templates (copied to live files on fresh clone) |

---

## Troubleshooting

### "Agent config not found" warnings at startup

The agent runner logs warnings if config files are missing. This is normal on first run — the fallback defaults are used. Once the bridge server starts, it snapshots defaults and the files are written.

### "Cannot edit agent instructions while jobs are running"

The bridge server prevents agent config edits when any ML pipeline job is active. Wait for jobs to complete or cancel them.

### "Cannot import/clear/restore/save-defaults configuration while jobs are running"

The Electron main process prevents import, clear, restore, and save-as-defaults operations when active jobs exist
(`config:set-defaults` and `agent-config:restore-defaults` are also guarded). In the UI, the Export/Import/Clear
header buttons and the Cloudflare Tunnel Start/Stop/Force Stop buttons are disabled while jobs run. Same solution: wait or cancel.

### Runner doesn't pick up config changes

After saving agent config:

1. The bridge (or direct write) touches `{userData}/agent-config/.restart-flag`
2. Electron's `fs.watch` detects the change
3. Electron restarts the agent runner

If the runner doesn't restart, check:

- The `.restart-flag` file exists
- The `fs.watch` is active (check main process logs)
- The runner PID file is present — the agent runner writes `agent-runner.pid` to the OS temp directory (`os.tmpdir()`)

### Config values not taking effect

Check the source annotation via `getConfigWithSources()` in the UI. A value showing `"default"` or `"environment"` may need to be saved explicitly in the ConfigPanel to override.
