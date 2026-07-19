# 🎙️ Transcription Agent — User Guide

Welcome! This guide walks you through everything you need to know to use Transcription Agent, from your first upload to reviewing results and sending summaries.

---

## 📖 Table of Contents

1. [What Is Transcription Agent?](#what-is-transcription-agent)
2. [Getting Started](#getting-started)
3. [Uploading Audio](#uploading-audio)
4. [The Transcription Pipeline](#the-transcription-pipeline)
5. [Reviewing Results](#reviewing-results)
6. [Managing Past Meetings](#managing-past-meetings)
7. [Settings & Configuration](#settings--configuration)
8. [Troubleshooting](#troubleshooting)

---

## What Is Transcription Agent?

Transcription Agent is a desktop application that automatically converts meeting recordings into written text. It can:

- **Transcribe** — turn speech into written words
- **Identify speakers** — recognize who said what
- **Summarize** — create an executive summary, extract key decisions and action items
- **Remember** — recall what was discussed in past meetings
- **Deliver** — send summaries via email, save to Google Drive, or create Trello cards

Everything runs on your computer. Your audio and transcripts stay private unless you choose to send them somewhere.

---

## Getting Started

### First-Time Setup

1. **Download and install** the app from the latest release (Windows or macOS)
2. **Launch the app** — you'll see the Upload screen
3. **Open Settings** — click the ⚙️ gear icon in the bottom bar
4. **Enter your API keys:**
   - **DeepSeek API Key** — this is the AI that processes your transcripts (required)
   - **Hugging Face Token** — needed for speaker identification (get one free at huggingface.co/settings/tokens)
5. **Close Settings** — the app is ready to use

### Understanding the Interface

The app has a clean, centered layout:

```
┌─────────────────────────────────────────────────────────┐
│  ← Sidebar    │            Main Content Area            │
│  (collapsible) │  📁 Upload Panel   │  📝 Results       │
│                │  (drag audio here, │  Viewer (tabbed,  │
│  📁 Current    │   set title, add   │   shows transcript│
│  🖥️ Appearance │   attendees)       │   summary,        │
│  ℹ️ About      │                    │   analysis, etc.) │
│                │  📊 Progress Panel │                   │
│                │  (pipeline status) │                   │
├────────────────┴────────────────────────────────────────┤
│  Status Bar  ⚙️  📋  💾  🖥️  🟢🟢🟢                    │
└─────────────────────────────────────────────────────────┘
```

**Sidebar buttons** on the left:

- 📁 **Current** — back to the main upload/view area
- 🖥️ **Appearance** — change theme (dark/light), font size, accent color
- ℹ️ **About** — app version and this guide

**Status Bar** at the bottom:

- Colored dots show if the backend services are running (green = OK, red = down)
- ⚙️ **Settings** — configure API keys and options
- 📋 **History** — browse past meetings
- 💾 **Storage** — view disk usage
- 🖥️ **Dev Tools** — for troubleshooting (logs, performance)

---

## Uploading Audio

### Supported File Types

| Format   | Notes                            |
| -------- | -------------------------------- |
| **WAV**  | Best quality, largest size       |
| **MP3**  | Good quality, smaller size       |
| **M4A**  | Common from phones and recorders |
| **FLAC** | Lossless compression             |
| **OGG**  | Open format                      |
| **WebM** | Common from web conferencing     |

Maximum file size: **500 MB**

### How to Upload

1. **Drag and drop** an audio file onto the upload area, **or** click to browse
2. **Give your meeting a title** — this helps find it later
3. **Add attendees** — type names of people in the meeting. The app will suggest names you've used before
4. **Choose what to skip** (optional):
   - Skip analysis (topics, sentiment) — for faster processing
   - Skip delivery prep — if you don't need email/Drive/Trello
   - Skip email / Drive / Trello — individual delivery toggles
5. Click **Upload & Transcribe**

> **Tip:** If a second person tries to upload while the first meeting is still processing, you'll see a message saying "A transcription job is already running." Wait for the current one to finish.
>
> The app also detects **bot-created jobs** (e.g., from the automated test script). When one is running, a pulsing badge appears on the Current sidebar button, and the main panel shows a "Bot Job Running" message with per-job status. Settings are locked until the bot job completes.

---

## The Transcription Pipeline

Once you upload, the app shows a progress tracker with these stages:

### 1. 📤 Uploading

Your audio file is being copied to the app's storage.

### 2. 🔧 Getting Ready

The app prepares the transcription system and loads AI models.

### 3. 👥 Identifying Speakers

The app listens for different voices and figures out when each person speaks. It can distinguish between different people but doesn't know their names yet.

### 4. 🏷️ Matching Voices

If the app has heard a speaker before (from a previous meeting), it automatically labels them by name. New speakers get temporary labels like "Speaker 1", "Speaker 2".

**If speaker labeling is needed:** If the number of detected speakers doesn't match the number of attendees you entered, the pipeline pauses. A popup appears with:

- **Audio clips** for each detected speaker — click the play button to hear a sample of their longest speech segment before assigning a name. Only one clip plays at a time.
- **Name and email input fields** — email is required and validated for proper format
- **Voiceprint conflict detection** (3 layers):
  1. **Name/Email Conflict** — if the entered name or email already has a voiceprint enrolled, a dialog shows the existing details (name, email, which job it came from). Choose **Overwrite** (per-name) or **Keep Existing**.
  2. **Voice-Match Verification** — after resolving name conflicts, the system compares proposed labels against all enrolled voiceprints. If a person's voice matches an existing voiceprint under a different name, a warning appears with similarity scores, the source job ID, and per-conflict **Accept**/**Reject** checkboxes before you can proceed. This is a hard block — unresolved conflicts prevent submission.
  3. **Unregistered Name Warning** — if a label matches no voiceprint at all, a non-blocking informational note is shown.
- **Inline per-speaker conflict warnings** — as you type a name or tab away from a name input, the system checks that single speaker against the voiceprint database. If a conflict is found, an inline warning appears below the email input with **Use "ExistingName"** / **Keep "NewName"** buttons, so you can resolve conflicts one at a time without waiting for the final confirmation dialog.
- **Backend error banner** — if the backend rejects the labels (e.g., a 409 voice-match conflict), a red error banner appears at the bottom of the modal with the specific error message and a dismiss button. The banner clears automatically when you edit any name or email input.
- **Non-speaking attendees** — registered attendees who were present but never spoke (no diarization segments detected) appear under **"Also present but did not speak"** in the modal. These names are passed to the AI for context and included in delivery records.
- **Confirm** to continue, **Skip** to use default names, or **Cancel** to stop

### 5. 🎤 Transcribing Speech

The app converts speech to text, word by word.

### 6. 🔗 Aligning

The app combines "who spoke when" (from step 3) with "what was said" (from step 5) to create a speaker-labeled transcript.

### 7. 🤖 AI Processing

This is where the AI does its work:

- **Refine** — removes filler words ("um", "uh", "like") and redacts sensitive information (emails, phone numbers)
- **Summarize** — creates an executive summary, lists key decisions and action items
- **Analyze** — identifies topics discussed, overall sentiment, and follow-up items
- **Save to Memory** — stores the meeting so the app can reference it in future meetings

### 8. 📬 Delivery (optional)

If you've configured email, Drive, or Trello integrations, the results are sent to those destinations.

---

## Reviewing Results

When processing is complete, the results appear in a tabbed viewer. The tabs are organized into **8 top-level views**, with the Developer tab containing 4 sub-tabs for technical details.

### 📊 Pipeline Tab

Shows a summary of all pipeline stages with checkmarks for completed steps.

### 📝 Transcript Tab

The full speaker-labeled transcript with:

- **Color-coded speakers** — each person has a different color
- **Timestamps** — click to jump to that point in the audio
- Scroll through the entire conversation

### 📋 Summary Tab

A structured summary with:

- **Executive Summary** — a brief overview of the meeting
- **Key Decisions** — what was decided
- **Discussion Points** — main topics covered
- **Action Items** — tasks assigned to people, with deadlines if mentioned. Each item has a checkbox to track completion.
- Each section is collapsible

Export buttons (**PDF** / **Word**) appear in the toolbar at the top of this tab.

### 📊 Analysis Tab

AI-generated analysis including:

- **Topics** — main subjects discussed
- **Sentiment** — overall tone of the meeting
- **Key Entities** — names, dates, amounts mentioned
- **Meeting Effectiveness** — how productive the meeting was
- **Follow-ups** — items that need future discussion

Export buttons (**PDF** / **Word**) appear in the toolbar at the top of this tab.

### 👥 Attendees Tab

Shows per-job attendee information with voiceprint enrollment status:

- **Name and email** — registered attendees for the meeting
- **Voiceprint status** — ✅ green checkmark if a voiceprint is enrolled, ❌ if not
- **Sample availability** — whether an audio sample exists for voiceprint matching
- **Linked job** — which previous job the voiceprint was captured from

This helps you quickly see who the system can automatically identify in future meetings based on previously stored voiceprints.

### 📬 Delivery Tab

Shows delivery status if you configured email, Drive, or Trello.

### 🎧 Audio Tab

An audio player lets you listen to the original recording. The **original filename** of the uploaded file is displayed below the meeting title so you can easily identify the source audio file.

### 🖥️ Developer Tab

The Developer tab groups four technical sub-tabs for debugging and inspection:

#### 🪙 Tokens

Shows how much AI processing was used (token count per pipeline step). Useful if you're on a paid API plan.

#### ⚡ Performance

Technical performance metrics showing processing times and resource usage during the job.

#### ⚙️ Config

Shows the full configuration snapshot captured when the job was created and processed:

- **Job Metadata** — title, event type, attendees, skipped pipeline steps
- **LLM & Model Config** — LLM provider and model, Whisper model size, diarization model, embedding provider, compute device, platform, voiceprint threshold
- **Agent Instructions** — list of enabled/disabled pipeline steps (green/grey chips), tool count, system prompt size, retry settings
- **Delivery & Logging** — delivery email settings, log configuration

This snapshot is frozen at job creation time, so you can see exactly what settings were active when the job ran — even if you've since changed them in the Settings panel.

#### 📋 Logs

Technical log files for troubleshooting. Supports **collapsible log groups** — consecutive lines with the same source and level are grouped into expandable entries to reduce visual noise during streaming output. Toggle this behavior on/off in **Settings → Logging** via the "Collapse Repeated Log Lines" option.

The Logs tab also has sub-tabs:

- **Pipeline** — main pipeline log for the job
- **Agent** — agent-only logs, excluding polling, usage, and raw I/O
- **Transcript** — refined transcript as logged during processing
- **Raw Transcript TXT** — the unrefined transcript text (before filler-word removal and PII redaction)

### 📤 Export

The **Summary** and **Analysis** tabs include export buttons for sharing results outside the app:

| Format          | How it works                                                                                                                                                         | Best for                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **PDF**         | Rendered via a hidden browser window → print-to-PDF → native Save dialog. Uses a clean print-friendly stylesheet with proper margins, typography, and table styling. | Archiving, printing, sharing with non-technical stakeholders |
| **Word (.doc)** | HTML content saved with a `.doc` extension — Word and other document editors open it natively. Office-compatible XML headers are included for best compatibility.    | Editing in a word processor, combining with other documents  |

Click **Export PDF** or **Export Word** in the toolbar at the top of the Summary or Analysis tab. A native file dialog opens where you choose the save location and filename.

---

## Managing Past Meetings

### Viewing History

1. Click **📋 History** in the status bar
2. Browse the list of past meetings (sorted by date)
3. Click any meeting to load its results

The History panel shows:

- Meeting title and date
- Status (Completed, Failed, etc.)
- Number of attendees
- Quick visual indicators

### Storage Management

1. Click **💾 Storage** in the status bar
2. See how much disk space is used by:
   - Log files
   - Transcription history
   - Vector database (semantic memory)
   - Other databases
   - Ollama models (if using local AI)

---

## Settings & Configuration

Click the **⚙️ gear icon** in the status bar to open Settings.

### LLM Provider Tab

Choose your AI provider:

- **DeepSeek (API)** — cloud-based, requires an API key. Fast and powerful.
  - Enter your **DeepSeek API Key** (sk-...)
- **Ollama (Local)** — runs AI on your computer. No API key needed.
  - Models: qwen3.6 or deepseekv2
  - Context window: 32K, 64K, or 128K tokens (larger = can process longer transcripts)

**Hugging Face Token** — required for speaker identification. Get one free at huggingface.co

**LLM Temperature** — controls randomness of the AI's outputs (range: 0.0–2.0).

- `0.1` (default) — very deterministic, best for factual transcript processing
- `0.3` — slightly more variation while staying on-task
- `0.7` — creative; good for brainstorming or varied summarization styles
- `1.0+` — increasingly random; may produce unexpected or less coherent results

**Whisper Model Size** — affects transcription accuracy vs. speed:

- `medium` (default) — good balance
- `large` — most accurate but slower

**Whisper Initial Prompt** (advanced) — optionally pass a text description of the meeting topic (e.g. "This is a technical discussion about software architecture") to Whisper before transcription begins. This helps bias the AI toward domain-specific vocabulary. Enable it in **Settings → Logging** via the "Whisper Initial Prompt" toggle and enter your prompt text.

### Services Tab

Configure integrations:

- **Gmail** — for sending summaries via email
- **Trello** — for creating action item cards
- **Google Drive** — for saving transcripts

### Delivery Config Tab

Default settings for delivery:

- **Recipient Emails** — who should receive summaries by default
- **Email Subject Template** — customize the subject line
- **Additional Email Content** — extra text to append to emails
- **Drive Folder** — where to save transcripts in Google Drive

### Auto-Update Tab

- **GitHub PAT** — only needed if the repository is private
- Update status shows your current version and checks for new versions
- Manual check and download buttons

### Agent Instructions Tab

For advanced users: customize the AI pipeline behavior by editing the underlying configuration files:

- **Pipeline Steps** — reorder, enable/disable, or add new pipeline stages (refine, summarize, analyze, etc.)
- **System Prompt** — customize the instructions given to the AI for each pipeline step
- **Tool Definitions** — define how each tool (email, Drive, Trello) operates
- **Context Window** — sliding window of step results sent to the LLM. 0 = send all steps (default). Higher values limit context to the last N step blocks, reducing token usage on long pipelines.

Changes take effect the next time a meeting is processed. Use **Restore Defaults** to reset to the original configuration.

### Logging Tab

Fine-tune how logs are recorded and displayed:

- **LLM Data Logging** — when enabled, the full AI prompt and response for each pipeline step are saved to the job's storage directory. Useful for debugging AI behavior, but can produce large log files.
- **Collapse Repeated Log Lines** — when enabled, consecutive log entries with the same source and level are grouped into collapsible entries in the Results Viewer's Logs tab, reducing visual noise.

### Testing Tab (in Settings)

Configure variables for the Playwright screenshot tests:

| Field                    | Description                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| **Audio File Path**      | Absolute path to an audio file (MP3/WAV) used by screenshot tests                            |
| **Test Title Template**  | Meeting title template (`{autoNum}` auto-increments)                                         |
| **Default Speaker Name** | Fallback name (used if >20 speakers detected) — see built-in 20-name list in the test source |

These same variables are also editable in **Dev Tools → Testing** tab, where you can run the tests directly.

---

## Dev Tools

Click the **🖥️ Dev Tools** button in the status bar to open the developer panel with these tabs:

| Tab             | Purpose                                                              |
| --------------- | -------------------------------------------------------------------- |
| **Live Logs**   | Real-time logs from Python, Bridge, Agent, and Main                  |
| **Database**    | Browse ephemeral memory, semantic memory (ChromaDB), and voiceprints |
| **Performance** | CPU/memory charts across jobs with pipeline stage markers            |
| **Usage**       | DeepSeek credit balance and per-job LLM token usage                  |
| **Updates**     | Check for and install app updates                                    |
| **Log Files**   | Browse per-job pipeline log files                                    |
| **Testing**     | Configure test variables and run Playwright screenshot tests         |

### Testing Tab (in Dev Tools)

The Testing tab has three sub-tabs:

#### Frontend (Playwright Screenshots)

1. **Edit test variables** — audio file path (with native file picker), title template, 20 generic speaker names (editable textarea)
2. **Live prerequisite checks** — backend services, audio file, and name count are monitored; Run button is disabled until all pass
3. **Run Tests** — launches Playwright with the configured variables
4. **View real-time output** — test output streams in as it runs
5. **See pass/fail status** — exit code and result displayed after completion

Variables are saved to `config.json` and persist across app restarts.

Screenshots are saved to **timestamped subdirectories** under `docs/screenshots/` (e.g. `docs/screenshots/2026-07-14/`). After each run, the images are copied to the root `docs/screenshots/` directory so the user guide always reflects the latest run. Prior runs remain accessible in their date-stamped folders.

> **Note:** Playwright screenshot tests are a dev-only feature. When the app is packaged (installed via NSIS/DMG), the Testing tab shows a banner explaining that tests must be run from the project directory via `npm run test`.

#### Backend (Test Bot Script)

The Backend sub-tab lets you run the automated test bot (`scripts/test-bot.mjs`) directly from the UI:

1. **Edit the CONFIG block** — audio file path, base job name, attendee list (name+email pairs), bridge URL, and polling interval
2. **Save** — persists your edits to `scripts/test-bot.mjs` (or to `userData/scripts/` in packaged mode)
3. **Run** — launches the test bot script, which sequentially processes 3 jobs through the backend with a sliding attendee progression
4. **View live output** — the script's stdout and stderr stream in real-time
5. **Stop** — terminates the running bot script (uses `taskkill` on Windows, `SIGKILL` on Unix)

The bot script automatically handles speaker labeling by fetching clips and assigning names from the attendee list. It also catches voice-match conflicts and reports them clearly.

#### Logs (Bot Test Run History)

View past test bot runs stored in `storage/test-bot-log.jsonl`. Each run shows:

- Test ID and timestamp
- Three job IDs created during the run
- Individual job status

---

## Troubleshooting

### App Won't Start

1. Make sure your computer meets the requirements
2. Try reinstalling the app
3. Check that no other instance is running

### Upload Fails

- **"Unsupported format"** — convert your audio to WAV or MP3
- **"File too large"** — files must be under 500 MB
- **"A transcription job is already running"** — wait for the current job to finish

### Processing Stalls

1. Check the status bar — are all services green?
2. If a service is red, try restarting it from the status bar
3. Long meetings can take 30+ minutes to process — be patient

### Speaker Not Identified

- Enter attendee names before uploading
- If the number of speakers doesn't match attendees, the app will pause and ask you to label them
- Once labeled, the app remembers voices for future meetings

### "Backend services are down"

1. Wait a moment — the app may be starting up
2. If it persists, restart the app
3. Check the Dev Tools (🖥️ in status bar) → Logs tab for error details

### Screenshot Tests Not Running

If the Dev Panel Testing tab shows an error when you click "Run Tests":

- Make sure the app is built: run `cd electron && npm run build`
- Verify backend services are running (Python :5001, Bridge :5010)
- Check that the audio file path points to an existing file
- Look in the **Live Logs** tab for "[testing]" prefixed messages

### How to Get Help

- Check the **Dev Tools** → **Logs** tab for error messages
- Look for error details in the pipeline failure message
- The app version is shown in **About** (ℹ️ in sidebar) — include this when reporting issues

---

## Manual Un-Installation

If you need to manually remove Transcription Agent from a Windows machine (e.g. the standard uninstaller fails), use the instructions below.

> **Note:** The standard uninstaller (via **"Add or remove programs" → "Transcription Agent" → Uninstall**) handles cleanup automatically using `deleteAppDataOnUninstall: true` and the NSIS `cleanup.nsh` script. Manual removal is only needed if the standard uninstaller does not work.

### Application Install

Installed to `Program Files`:

```
C:\Program Files\Transcription Agent\
```

| Path                                | Contents                                |
| ----------------------------------- | --------------------------------------- |
| `Transcription Agent.exe`           | Electron app launcher                   |
| `resources\app.asar`                | Packaged Electron app (main + renderer) |
| `resources\python-backend\`         | PyInstaller-built Python backend        |
| `resources\bridge-server\`          | Node.js bridge server                   |
| `resources\agent-runner\`           | Node.js agent runner                    |
| `resources\node-bin\`               | Bundled Node.js v20 LTS binary          |
| `Uninstall Transcription Agent.exe` | NSIS uninstaller                        |

### User Data

```
%APPDATA%\Transcription Agent\
```

Typically resolves to:

```
C:\Users\<YourUsername>\AppData\Roaming\Transcription Agent\
```

| Path                          | Contents                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| `config.json`                 | UI-saved configuration values                                 |
| `storage\`                    | All job data (transcripts, audio, status, embeddings)         |
| `storage\<job_id>\`           | Per-job directory (status.json, transcript.json, audio, logs) |
| `storage\chroma\`             | ChromaDB vector store (semantic memory)                       |
| `storage\ephemeral_memory.db` | SQLite DB (action items, contacts, budgets, decisions)        |
| `storage\voiceprints.db`      | SQLite DB (enrolled speaker voiceprints)                      |
| `storage\logs\`               | Agent runner JSONL logs                                       |
| `storage\uploads\`            | Temp upload directory (cleaned after processing)              |
| `storage\test-bot-log.jsonl`  | Test bot run logs                                             |
| `logs\`                       | Electron main process logs                                    |
| `queue\`                      | Pipeline job queue files                                      |
| `bin\ffmpeg.exe`              | Auto-downloaded ffmpeg binary                                 |
| `.ollama-auto-installed`      | Sentinel (Ollama was auto-installed)                          |
| `.ffmpeg-auto-installed`      | Sentinel (ffmpeg was auto-installed)                          |

### Ollama (if auto-installed)

```
%LOCALAPPDATA%\Programs\Ollama\
```

or

```
C:\Program Files\Ollama\
```

### Manual Deletion

```cmd
:: App install (run as Administrator)
rmdir /s "C:\Program Files\Transcription Agent"

:: User data
rmdir /s "%APPDATA%\Transcription Agent"

:: Ollama (if auto-installed)
rmdir /s "%LOCALAPPDATA%\Programs\Ollama"
```
