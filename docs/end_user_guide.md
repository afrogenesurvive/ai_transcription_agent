# 🎙️ Transcription Agent — User Guide

Welcome! This guide walks you through everything you need to know to use Transcription Agent, from your first upload to reviewing results and sending summaries.

---

## 📖 Table of Contents

1. [What Is Transcription Agent?](#what-is-transcription-agent)
2. [Getting Started](#getting-started)
3. [Uploading Audio](#uploading-audio)
4. [The Transcription Pipeline](#the-transcription-pipeline)
5. [Approval Gates](#approval-gates)
6. [Reviewing Results](#reviewing-results)
7. [Managing Past Meetings](#managing-past-meetings)
8. [Settings & Configuration](#settings--configuration)
9. [Appearance Settings](#appearance-settings)
10. [Dev Tools](#dev-tools)
11. [Notifications](#notifications)
12. [Server Status Banner](#server-status-banner)
13. [Troubleshooting](#troubleshooting)

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

> **Config Required Overlay:** If you close Settings without entering an API key, a full-screen overlay appears blocking other views. Click **Open Settings** to return to the Config panel, or **Import Config** to load a previously exported config JSON file. The overlay auto-hides once configuration is complete.

### Understanding the Interface

The app has a clean, centered layout:

```
┌──────────────────────────────────────────────────────────────────┐
│  Header: 🎙️ Transcription Agent      [● Job Running · a1b2c3d4]  │
├──────┬───────────────────────────────────────────────────────────┤
│ ←Sbdr│              Main Content Area                           │
│      │  📁 Upload Form       │  📝 Results Viewer (tabbed)       │
│  ➕  │  (drag audio, set     │  Pipeline · Transcript · Summary  │
│  🏠  │   title, add attendees│  Analysis · Attendees · Delivery  │
│  📋  │   with autocomplete)  │  Audio · Developer 🖥️             │
│  💾  │                       │                                   │
│  🛠️  │  📊 Pipeline Progress │                                   │
│  ⚙️  │  (stepper, progress   │                                   │
│  🎨  │   bar, mini live log) │                                   │
│  ℹ️  │                       │                                   │
├──────┴───────────────────────────────────────────────────────────┤
│ Status Bar  🟢Config 🟢Diar 🟢Py 🟢Bridge 🟢Agent 🟢Ollama 💰$12.34 │
│  ⚙️ 📋 💾 🖥️                                                │
└──────────────────────────────────────────────────────────────────┘
```

**Sidebar buttons** on the left (drag the right edge to resize):

| Button         | Icon | Action                                                                              |
| -------------- | ---- | ----------------------------------------------------------------------------------- |
| **New**        | ➕   | Start a new transcription — opens the upload form. Disabled while a job is running. |
| **Current**    | 🏠   | View the active or most recent job — pipeline progress, transcript, results         |
| **History**    | 📋   | Browse past transcription jobs — reload or delete previous sessions                 |
| **Storage**    | 💾   | View disk usage breakdown — jobs, logs, databases, and models                       |
| **Dev**        | 🛠️   | Developer tools — live logs, database browser, performance metrics, updates         |
| **Config**     | ⚙️   | Configure API keys, LLM provider, delivery services, and agent pipeline settings    |
| **Appearance** | 🎨   | Customize theme, accent color, font size, and sidebar width                         |
| **About**      | ℹ️   | App version, name, and README                                                       |

A **pulsing orange badge** appears on the Current button when bot-created test jobs are running.

The sidebar can be **dragged wider or narrower** by clicking and dragging the resize handle on its right edge.

**Status Bar** at the bottom:

| Element                          | Description                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Config** dot                   | 🟢 green = LLM provider configured, 🔴 red = missing API key                                                                    |
| **Diarization** dot              | 🟢 green = speaker diarization model available                                                                                  |
| **Python / Bridge / Agent** dots | 🟢 = service running, 🔴 = stopped, ⚪ = checking                                                                               |
| **Ollama** dot                   | 🟢 = Ollama server running, 🔴 = offline, ⚪ = not the active provider. Shown dimmed when Ollama is not the active LLM provider |
| **💰 Balance**                   | DeepSeek credit balance (click to see popover with details)                                                                     |
| **Per-service controls**         | Click a running service's ■ button to stop it, or ▶ to restart a stopped service                                                |
| ⚙️ **Settings**                  | Open the configuration panel                                                                                                    |
| 📋 **History**                   | Browse past meetings                                                                                                            |
| 💾 **Storage**                   | View disk usage                                                                                                                 |
| 🖥️ **Dev Tools**                 | Open developer tools                                                                                                            |

**Header bar** at the top:

- Shows the app title and a **Job Running indicator** when a transcription is active — displays the short job ID. Click on it to copy the full job ID to your clipboard.

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

1. **Drag and drop** an audio file onto the upload area, **or** click to browse. The app auto-fills the meeting title from the filename.
2. **Give your meeting a title** — this helps find it later.
3. **Add attendees** — type names and email addresses of people in the meeting.

   **Attendee Autocomplete:** As you type a name, the app suggests previously used attendees from past meetings (saved to local storage, capped at 50 entries). Suggestions also include registered attendees from the backend with existing voiceprints. Click a suggestion to fill both name and email at once.

   **Email validation:** Each attendee must have a valid email address. The app checks the format before adding them to the list.

   **Conflict detection:** When you add an attendee, the app checks the name and email against the attendee registry and voiceprint database. If a mismatch is detected, a warning banner appears with details. For example, if you enter an email that is already registered under a different name, or a name that already has a different email on file, the warning explains the conflict so you can correct the entry before uploading.

   **Registered attendee indicators:** Previously registered attendees show a play button — click it to hear their voiceprint sample from an earlier meeting.

   > **Tip:** Saved attendees persist across app restarts and are shared between all jobs.

4. **Choose what to skip** (optional) — individual checkboxes for:
   - **Skip refine** — skip filler-word removal and PII redaction
   - **Skip analysis** — skip topics, sentiment, and entity extraction (faster processing)
   - **Skip delivery prep** — skip preparing emails, Drive, and Trello content
   - **Skip email** — disable email delivery for this job
   - **Skip Drive** — disable Google Drive save for this job
   - **Skip Trello** — disable Trello card creation for this job

   The initial set of checked skips is derived from your **Agent Instructions** pipeline settings — steps you've disabled there will be pre-checked here.

5. Click **Upload & Transcribe**

> **Tip:** If a second person tries to upload while the first meeting is still processing, the "New" sidebar button is disabled, and you'll see a message saying "A transcription job is already running." Wait for the current one to finish.
>
> The app also detects **bot-created jobs** (e.g., from the automated test script). When one is running:
>
> - A pulsing orange badge appears on the Current sidebar button
> - The main panel shows a full pipeline stepper with the bot job's real-time status
> - A "Bot / Test Job" badge appears in the pipeline header
> - Settings are locked until the bot job completes
> - You can cancel all bot jobs with a single "Stop" button

---

## The Transcription Pipeline

Once you upload, the app shows a **pipeline progress tracker** with a vertical stepper showing all stages. Each stage shows:

- An icon, a friendly label, and a plain-English description
- ✅ **Done** — green checkmark for completed stages
- 🔄 **In progress** — spinning animation on the active stage with a pulsing "In progress" badge
- ○ **Pending** — dimmed for upcoming stages
- ❌ **Error** — red if a stage has failed
- ➖ **Skipped** — greyed out with strikethrough when a step was explicitly skipped (e.g., analysis disabled)

The **progress bar** at the top fills from left to right and shows the percentage complete. When the pipeline finishes, it turns green at 100%. If it fails, it turns red and shows "Failed."

Below the stepper, a **Mini Live Log** shows the last few log entries from the backend in real-time, color-coded by source (blue for Python, green for Bridge, yellow for Agent). Click the header to collapse or expand it.

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
  1. **Name/Email Conflict** — if the entered name or email already has a voiceprint enrolled under a **different** name, a conflict dialog appears showing the existing details (name, email, and which job it came from).
     - _Example: If you enter the name "Jane Smith" with email "john@example.com", but "john@example.com" is already enrolled under "John Doe" from a previous meeting, the dialog shows "Jane Smith ← currently enrolled as John Doe"._
     - **How to resolve:**
       - **Overwrite** — check the **"Overwrite with this recording"** checkbox, then click **Confirm Labels**. This replaces the existing voiceprint record (name, email, and voiceprint embedding) with the current speaker's data. Future meetings will auto-identify this voice as the new name.
       - **Keep Existing** — click **Cancel** to dismiss the dialog. This returns you to the speaker list where you can edit the name or email to avoid the conflict, then re-submit. The existing voiceprint is left untouched.
  2. **Voice-Match Verification** — after resolving name conflicts, the system compares proposed labels against all enrolled voiceprints. If a person's voice matches an existing voiceprint under a different name, a warning appears with similarity scores, the source job ID, and per-conflict **Accept**/**Reject** checkboxes before you can proceed. This is a hard block — unresolved conflicts prevent submission.
  3. **Unregistered Name Warning** — if a label matches no voiceprint at all, a non-blocking informational note is shown.
- **Inline per-speaker conflict warnings** — as you type a name or tab away from a name input, the system checks that single speaker against the voiceprint database. If a conflict is found, an inline warning appears below the email input with **Use "ExistingName"** / **Keep "NewName"** buttons, so you can resolve conflicts one at a time without waiting for the final confirmation dialog.
- **Backend error banner** — if the backend rejects the labels (e.g., a 409 voice-match conflict), a red error banner appears at the bottom of the modal with the specific error message and a dismiss button. The banner clears automatically when you edit any name or email input.
- **Non-speaking attendees** — registered attendees who were present but never spoke (no diarization segments detected) appear under **"Also present but did not speak"** in the modal. These names are passed to the AI for context and included in delivery records.
- **Confirm** to continue, **Skip** to use default names, or **Cancel** to stop

### 5. 🎤 Transcribing Speech

The app converts speech to text, word by word.

### 6. 🔗 Aligning (Building Transcript)

The app combines "who spoke when" (from step 3) with "what was said" (from step 5) to create a speaker-labeled transcript.

### 7a. 📝 Review Transcript (optional)

**If the Raw Transcript Review gate is enabled** in Settings → Config → Pipeline section, the pipeline pauses here after alignment. A modal appears showing the raw (unrefined) transcript for your review:

- **View** the full raw transcript before AI processing
- **Edit** the transcript text inline — click the **Edit** button to make changes
- **Approve** the transcript as-is or with edits — the pipeline continues to AI processing
- **Reject** — temporarily disabled (buttons are greyed out in the modal). The pipeline must be approved to continue.

See the [Approval Gates](#approval-gates) section for full details.

### 7b. 🤖 AI Processing

This is where the AI does its work:

- **Fetch Memory Context** — retrieves past action items, decisions, and budgets from previous meetings for continuity
- **Refine** — redacts sensitive information (emails, phone numbers, SSNs, credit cards)
- **Summarize** — creates an executive summary, lists key decisions and action items
- **Analyze** — identifies topics discussed, overall sentiment, and follow-up items
- **Review & Approve Delivery** — pauses for you to review the transcript, summary, analysis, and delivery options before proceeding
- **Save to Memory** — stores the meeting so the app can reference it in future meetings

### 8. 💾 Saving to Memory

The meeting context (action items, decisions, budgets, contacts) is saved to **ephemeral memory** (structured data) and **semantic memory** (ChromaDB vector store) for future reference. The app can recall what was discussed in past meetings through the semantic search in Dev Tools.

### 9a. 📬 Review Deliverable

The pipeline pauses here for you to review the deliverables before saving to memory and sending. A modal appears showing:

- **Summary** — the executive summary, key decisions, discussion points, and action items
- **Analysis** — topics, sentiment, key entities, and follow-ups
- **Transcript** — the full refined speaker-labeled transcript
- **Delivery options** — email recipients and optional content to include
- **Edit** — click the **Edit** button to modify the summary and analysis content
- **Approve** — the deliverable is saved to memory and delivery proceeds to the configured destinations
- **Reject** — temporarily disabled (buttons are greyed out in the modal). The pipeline must be approved to continue.

You can disable this gate in **Settings → Config → Pipeline** by toggling the **Review & Approve Delivery** step off.

### 9b. 📬 Delivery

After you approve the deliverable, results are sent to the configured destinations:

- **Email** — the meeting summary, analysis, and attendee data are sent to recipients (the full transcript is excluded by default)
- **Google Drive** — saves a copy of the meeting summary and analysis (disabled by default; enable in Settings → Config → Pipeline)
- **Trello** — creates action items as Trello cards (disabled by default; enable in Settings → Config → Pipeline)

The results viewer's **Delivery** tab shows per-destination success/failure status after completion.

### Stopping a Job

While the pipeline is running, a **Stop Processing** button appears below the stepper. Clicking it opens a confirmation dialog:

> **"Are you sure you want to stop processing? The partial results will be preserved."**

Confirm to cancel the job. The results viewer opens showing whatever was completed so far, along with a "Cancelled by user" message.

---

## Approval Gates

Approval Gates allow you to review and approve (or reject) the pipeline output at key stages before it proceeds further. They are **optional** — enable them in **Settings → Config → Pipeline** section by toggling the checkboxes.

### Gate 1: Raw Transcript Review

When enabled, the pipeline pauses after the transcript is built but **before** AI processing begins. A modal dialog appears with:

- **Raw transcript** — the unrefined, unedited transcript text (before filler-word removal and PII redaction)
- **Edit mode** — click the **Edit** button in the action row to open an editable textarea. Make changes to the raw text, then click **Save**.
- **Approve** — accepts the transcript (with or without edits). The pipeline resumes to AI processing.
- **Reject** — temporarily disabled (buttons are greyed out in the modal). The pipeline must be approved to continue.

### Gate 2: Delivery Review

When enabled, the pipeline pauses after AI processing is complete but **before** results are saved to memory or delivered. A modal dialog appears with:

- **Summary** — the AI-generated executive summary, key decisions, discussion points, and action items
- **Analysis** — the AI-generated topics, sentiment, key entities, effectiveness, and follow-ups
- **Transcript** — the refined speaker-labeled transcript
- **Edit mode** — click **Edit** in the action row to open editable fields for the summary (textareas for each section, add/remove action items) and analysis (textareas, add/remove topics and entities). Click **Save** when done.
- **Approve** — accepts the deliverable package. Results are saved to memory and delivered to configured destinations.
- **Reject** — temporarily disabled (buttons are greyed out in the modal). The pipeline must be approved to continue.

---

## Reviewing Results

When processing is complete, the results appear in a tabbed viewer. The tabs are organized into **10 top-level views**, with the Developer tab containing 4 sub-tabs for technical details.

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

**Editing:** Click the ✏️ **Edit** button in the toolbar to modify the summary content after the job completes. You can:

- Edit the executive summary text
- Add or remove discussion points and key decisions
- Add, edit, or remove action items (description, assignee, deadline)
- Changes are saved to disk with an audit trail

Export buttons (**PDF** / **Word**) appear in the toolbar at the top of this tab.

### 📊 Analysis Tab

AI-generated analysis including:

- **Topics** — main subjects discussed (shown as tags)
- **Sentiment** — overall tone of the meeting
- **Key Entities** — names, dates, amounts mentioned
- **Meeting Effectiveness** — how productive the meeting was
- **Follow-ups** — items that need future discussion

**Editing:** Click the ✏️ **Edit** button in the toolbar to modify the analysis content after the job completes. You can:

- Add or remove topics, key entities, and follow-ups
- Edit the sentiment and effectiveness descriptions
- Changes are saved to disk with an audit trail

Export buttons (**PDF** / **Word**) appear in the toolbar at the top of this tab.

### 👥 Attendees Tab

Shows per-job attendee information with voiceprint enrollment status, playable voice samples, and delivery cross-reference:

- **Summary cards** — total attendees, voiceprint-matched count, registered-only count
- **Voiceprint-matched attendees** — each card shows:
  - Avatar with first letter of the name
  - **Name and email** — registered for the meeting
  - **Voiceprint status** — ✅ green checkmark if enrolled
  - **Play button** — click to hear the attendee's voiceprint sample from a previous meeting. Only one sample plays at a time.
  - **Linked job** — which previous job the voiceprint was captured from
- **Registered-only attendees** (no voiceprint) — listed below with muted styling
- **Delivery cross-reference** — shows whether each attendee received delivery results
- **Export** — PDF/Word export of the attendee table with voiceprint and delivery status

This helps you quickly see who the system can automatically identify in future meetings based on previously stored voiceprints.

### 📬 Delivery Tab

Shows per-destination delivery results with success/failure status for each configured delivery method:

- **Summary cards** — total deliveries, succeeded count, failed count
- **Per-delivery cards** — one card per delivery method (Email, Drive, Trello), each showing:
  - Delivery method name and icon
  - ✅ **Success** or ❌ **Failed** badge
  - **Result details** — expand to see the raw result data (recipients, folder name, card IDs, etc.)
  - **Timestamp** of when the delivery was attempted
- **Delivery data unavailable** — shown when the job didn't have delivery steps configured

### 🎧 Audio Tab

An audio player lets you listen to the original recording. The **original filename** of the uploaded file is displayed below the meeting title so you can easily identify the source audio file.

### 🖥️ Developer Tab

The Developer tab groups four technical sub-tabs for debugging and inspection:

#### 🪙 Tokens

Shows how much AI processing was used (token count per pipeline step). Useful if you're on a paid API plan.

#### ⚡ Performance

Technical performance metrics showing CPU and memory usage during the job:

- **SVG chart** — plots CPU % (solid blue line) and memory usage (dashed green line) over time
- **Stage markers** — vertical dashed lines show when pipeline stage transitions occurred (Upload, Init, Speakers, Voices, Transcribe, Align, AI, Memory, Delivery)
- **Time labels** — elapsed time in seconds along the X axis
- **Sample count** — shows how many data points were collected during the job
- Polls every 5 seconds for live updates during active jobs

#### ⚙️ Config

Shows the full configuration snapshot captured when the job was created and processed:

- **Job Metadata** — title, event type, attendees, skipped pipeline steps
- **LLM & Model Config** — LLM provider and model, Whisper model size, diarization model, embedding provider, compute device, platform, voiceprint threshold
- **Pipeline Steps** — detailed rows showing each step: step number, label, tool name (monospace), description, enabled/disabled status, terminal badge. Steps are shown in their configured order.
- **Pipeline Hints** — collapsible section showing the full key→value hint map for each pipeline step
- **Pipeline Constants** — collapsible section showing max pipeline steps, LLM context window, Ollama max retries and retry delay
- **Event Templates** — collapsible section showing the ready_for_processing, labeling_needed, and failed event templates as code blocks
- **System Prompt** — collapsible section showing the full system prompt text
- **Tool Count** — number of registered tools available to the LLM
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

T8210P3421270A30

## Managing Past Meetings

### Viewing History

1. Click **📋 History** in the sidebar, or **📋 History** in the status bar
2. The left column switches to a scrollable list of past meetings (sorted by date, most recent first)
3. Click any meeting to load its results in the right column

The History panel shows:

- **Status icon** — visual indicator per status (📤 Uploaded, 🔧 Initializing, 👥 Diarization, 🎤 Transcribing, ✅ Completed, ❌ Failed, ⚠️ Corrupted)
- **Meeting title** and **date** (shown as relative time: "Just now", "5m ago", "2h ago", or full date for older items)
- **Attendee names** — listed below the title
- **Pipeline stage badges** — click the expand arrow (▼) to see a mini pipeline stepper showing which stages completed and which failed
- **Delete button** 🗑️ — visible on hover. Clicking shows a confirmation dialog before permanently removing the job and all its files.

The history panel has a **drag-to-resize** handle on its right edge — click and drag to make the history list wider or narrower. You can also **collapse** the left column entirely by clicking the collapse button, giving the results viewer full width.

### Storage Management

1. Click **💾 Storage** in the sidebar, or **💾 Storage** in the status bar
2. See a visual breakdown of disk space across **6 categories**:

| Category          | Contents                                                  | Color     |
| ----------------- | --------------------------------------------------------- | --------- |
| **History**       | Transcription job data (transcripts, audio, status files) | 🔵 Blue   |
| **Logs**          | Application log files (.jsonl)                            | 🟡 Yellow |
| **ChromaDB**      | Vector store for semantic memory                          | 🟢 Green  |
| **Databases**     | Ephemeral memory + voiceprint SQLite databases            | 🟣 Purple |
| **System**        | Source code, config, dependencies                         | ⚪ Grey   |
| **Ollama Models** | Downloaded LLM models (~/.ollama)                         | 🔴 Red    |

Each category shows the disk size and the file path on disk.

**Developer Section** (collapsible) — for clearing data:

| Action                        | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| 🗑️ **Clear All Logs**         | Deletes all `.jsonl` log files from the logs directory          |
| ⚠️ **Delete Error Logs Only** | Removes only log entries with errors (red-bordered danger zone) |
| 🗑️ **Clear Job History**      | Deletes all completed job data (confirmation required)          |
| 🗑️ **Clear Semantic Memory**  | Wipes the ChromaDB vector store                                 |
| 🗑️ **Clear Databases**        | Resets ephemeral memory and voiceprint databases                |

All destructive actions require a confirmation dialog before proceeding. Storage usage auto-refreshes after any deletion.

---

## Settings & Configuration

Click the **⚙️ gear icon** in the sidebar (or the status bar) to open the Configuration panel.

The Config panel has three tabs at the top: **Config**, **Agent**, and **Logging**. Below the tabs, a **section sub-tab bar** lets you navigate between sections within the active tab.

> **Note:** When a transcription job is actively running, all configuration fields are disabled. A banner at the top shows "⛔ Cannot edit — N job(s) running." Wait for the job to complete before making changes.

### Config Tab

#### LLM Provider Section

Choose your AI provider:

- **DeepSeek (API)** — cloud-based, requires an API key. Fast and powerful.
  - Enter your **DeepSeek API Key** (sk-...)
- **Ollama (Local)** — runs AI on your computer. No API key needed.
  - **Server status** — a green/red indicator next to the Ollama option shows whether the Ollama server is running
  - **Model management** — click "List Models" to see installed Ollama models with size and modified date. Use the **Pull** button to download new models from the registry. A loading indicator shows pull progress.
  - **Context window**: 32K, 64K, or 128K tokens (larger = can process longer transcripts)

**Hugging Face Token** — required for speaker identification. Get one free at huggingface.co

**LLM Temperature** — controls randomness of the AI's outputs (range: 0.0–2.0).

- `0.1` (default) — very deterministic, best for factual transcript processing
- `0.3` — slightly more variation while staying on-task
- `0.7` — creative; good for brainstorming or varied summarization styles
- `1.0+` — increasingly random; may produce unexpected or less coherent results

**Whisper Model Size** — affects transcription accuracy vs. speed:

- `medium` (default) — good balance
- `large` — most accurate but slower

**Whisper Initial Prompt** (advanced) — enable the "Whisper Initial Prompt" toggle to show a text field where you can enter a description of the meeting topic (e.g. "This is a technical discussion about software architecture"). This helps bias Whisper toward domain-specific vocabulary.

**Keep Transcript Timestamps** — when enabled, timestamps are preserved in the refined transcript (default: on).

**Pipeline Timeout** — maximum time (in minutes) the pipeline can run before timing out. Default: 15 minutes.

**Keep Models Warm** — when enabled, AI models stay loaded in memory between jobs for faster startup on subsequent runs.

#### Pipeline Section

Configure optional approval gates:

| Setting                            | Description                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Raw Transcript Review (Gate 1)** | When enabled, the pipeline pauses after alignment for you to review the raw transcript before AI processing    |
| **Delivery Review (Gate 2)**       | When enabled, the pipeline pauses after AI processing for you to review the deliverable package before sending |

See the [Approval Gates](#approval-gates) section for details of each gate's workflow.

#### Services Section

Configure integrations for delivering results:

| Service          | Fields Required                                     |
| ---------------- | --------------------------------------------------- |
| **Gmail**        | Client ID, Client Secret, Refresh Token, User Email |
| **Trello**       | API Key, Token                                      |
| **Google Drive** | Uses the same Gmail OAuth credentials               |

Each service has a collapsible accordion — click to expand and fill in the credentials.

#### Delivery Config Section

Default settings for delivery:

- **Recipient Emails** — comma-separated list of who should receive summaries by default (validated for proper email format)
- **Email Subject Template** — customize the subject line (use `{title}` as a placeholder)
- **Additional Email Content** — extra text to append to emails
- **Drive Folder** — where to save transcripts in Google Drive

#### Auto-Update Section

- **GitHub PAT** — only needed if the repository is private
- Shows current version and checks for updates (auto-check every 12 hours in both dev and packaged modes)
- Manual **Check for Updates** button
- When an update is available: **Download** button (packaged mode) with progress %, then **Install & Restart**

#### Export / Import

- **📤 Export Config** — saves all settings (including agent instructions) to a `.json` file via the native save dialog
- **📥 Import Config** — loads settings from a previously exported `.json` file via the native open dialog. Imports all config values plus agent instructions. Services are restarted after import. Blocked if jobs are still running.

### Agent Tab

For advanced users: customize the AI pipeline behavior.

> **Note:** All agent instructions are loaded from disk on this tab and saved back to disk. Editing is done in-memory and persisted when you click **Save Agent Config**. Changes take effect the next time a meeting is processed.

**Pipeline Steps** (draggable checklist):

- Each pipeline step is shown as a row with:
  - **Drag handle** (⣿) — click and drag to reorder steps
  - **Enable/disable toggle** (checkbox) — unchecked steps are skipped
  - **Label** and **tool name** (monospace)
  - **Description** — brief explanation of what the step does
  - **Terminal badge** — marks steps that end the pipeline
  - **Expand button** (▼) — click to edit the step's **System Prompt Template** and **Hint Template** (advanced)
- Use **Restore Defaults** to reset to the original configuration

**Context Window** — sliding window of step results sent to the LLM. `0` = send all steps (default). Higher values limit context to the last N step blocks, reducing token usage on long pipelines.

**Max Pipeline Steps** — maximum number of tool calls the LLM can make in a single pipeline run.

**Max Retries** — how many times the pipeline retries after a failure.

**Retry Base Delay** — initial delay (in milliseconds) between retries (exponential backoff).

### Logging Tab

Fine-tune how logs are recorded and displayed:

| Setting                         | Description                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM Data Logging**            | When enabled, the full AI prompt and response for each pipeline step are saved to the job's storage directory. Useful for debugging AI behavior, but can produce large log files. |
| **Collapse Repeated Log Lines** | When enabled, consecutive log entries with the same source and level are grouped into collapsible entries in the Results Viewer's Logs tab, reducing visual noise.                |
| **Log Sources**                 | Checkboxes to enable/disable disk logging per source (Python, Bridge, Agent, Main). Unchecked sources are still shown in the in-memory live log but NOT written to disk.          |
| **Log Level**                   | Minimum level to write to disk: `debug` (everything), `info`, `warn`, `error`, or `off` (nothing to disk).                                                                        |
| **Max File Size**               | Maximum size per log file before rotation (default: 50 MB).                                                                                                                       |
| **Max Files**                   | Maximum number of rotated log files to keep (default: 10).                                                                                                                        |

The Testing tab is located in **Dev Tools → Testing** — see the [Dev Tools → Testing Tab](#testing-tab) section below for full details.

---

## Dev Tools

Click the **�️ Dev** button in the sidebar (or **🖥️ Dev Tools** in the status bar) to open the developer panel. A confirmation dialog appears the first time — click **Proceed** to continue.

The Dev panel has the following tabs:

### Live Logs Tab

Real-time log viewer showing log entries from all four services (Python, Bridge, Agent, Main). Features:

- **Source filter** — show logs from All, Python, Bridge, Agent, or Main
- **Sub-source filter** — narrow by sub-source: Agent Bridge, Pipeline, Runner, Model, Transcription, Voiceprint, Memory, Upload, Config, Startup, Auto-Update, Ephemeral, Semantic Memory, and more
- **Level filter** — All, Info, Warnings, Errors, or Debug
- **🔍 Text search** — filter logs by keyword with highlighted matches
- **Auto-scroll toggle** — automatically scrolls to the bottom as new entries arrive
- **Clear button** — removes all entries from the current view (in-memory buffer preserved)
- Logs are capped at 1,000 entries in memory; older entries are dropped

### Database Tab

Browse the app's internal databases with three sub-views:

#### Ephemeral Memory

- Lists all tables in the ephemeral memory SQLite database (action_items, contacts, budgets, decisions, etc.)
- Click a table to browse up to 100 rows with column headers
- Expand any row (▶) to see the full cell content
- Resizable column headers — drag the right edge of any header to resize

#### Semantic Memory (ChromaDB)

- **Stats** — total chunks, unique meetings, chunks by type (summary, transcript, action_items), embedding dimension, HNSW space
- **Cross-meeting overlap** — common attendees (appearing in 2+ meetings) with meeting tags; keyword overlap as an opacity-weighted tag cloud
- **🔍 Search** — enter a query (e.g. "budget discussion", "Q4 planning") to search ChromaDB with relevance scores, meeting title, and document snippets

#### Voiceprints

- Lists all enrolled voiceprints with name, email, linked job ID, and sample availability
- **Play button** ▶ — hear the voiceprint sample for any enrolled speaker
- **Delete button** 🗑️ — remove a single voiceprint with confirmation

### Performance Tab

Real-time CPU and memory monitoring across all jobs:

- SVG line chart with CPU % (blue) and memory usage (green dashed line)
- Pipeline stage transition markers (vertical dashed lines)
- Auto-scaling Y axis and elapsed time X axis
- Polls every 5 seconds for live data during active processing

### Usage Tab

- **DeepSeek Credit Balance** — shows current API credit balance (polls every 60 seconds)
- **Per-job LLM Token Usage** — select any completed job to see its token breakdown (via the Tokens tab in the Results Viewer)

### Updates Tab

Check for and install app updates:

| Field               | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| **Mode**            | Dev (git-based) or Packaged (electron-updater) — auto-detected |
| **Current Version** | The installed app version                                      |
| **Update Status**   | Checking, Up-to-date, or Update Available                      |
| **Last Check**      | When the last update check was performed                       |
| **Last Update**     | When the app was last updated                                  |
| **Auto-check**      | Toggle to enable/disable automatic update checking             |

Buttons: **Check for Updates**, **Download** (packaged mode only, with progress %), **Restart & Install**

### Log Files Tab

Browse on-disk log files from both the primary (userData) and mirror (dev storage) directories:

- Lists all `.jsonl` log files with file size and last modified date
- Click any file to view its contents in the built-in viewer
- **Pipeline logs** — per-job `pipeline.log` files showing agent trace output

### Testing Tab

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
5. **Stop** — terminates the running bot script (uses `taskkill` on Windows, `SIGKILL` on Unix). Also cancels all active pipeline jobs via the bridge API.

The bot script automatically handles speaker labeling by fetching clips and assigning names from the attendee list. It also catches voice-match conflicts and reports them clearly.

#### Logs (Bot Test Run History)

View past test bot runs stored in `storage/test-bot-log.jsonl`. Each run shows:

- Test ID and timestamp
- Three job IDs created during the run
- Individual job status

### Stop All Jobs Button

When bot jobs or pipeline jobs are running, a **Stop** button appears in the Dev Panel toolbar. Click it to cancel all active transcription jobs (both user-initiated and bot-created) and kill the local test script process.

---

## Appearance Settings

Click the **🎨 Appearance** button in the sidebar to customize the look and feel of the app. All changes are saved automatically — no save button needed.

### Theme

Choose between three options:

| Theme      | Description                                                                   |
| ---------- | ----------------------------------------------------------------------------- |
| **Dark**   | Dark background with light text — easy on the eyes for low-light environments |
| **Light**  | Light background with dark text — bright appearance for well-lit environments |
| **System** | Automatically follows your operating system's dark/light preference           |

### Accent Color

Choose from 8 preset colors or pick any custom color:

| Preset                                               | Color                                        |
| ---------------------------------------------------- | -------------------------------------------- |
| Blue, Green, Purple, Pink, Orange, Red, Teal, Yellow | Click a swatch to apply instantly            |
| **Custom**                                           | Use the color picker to select any hex color |

The accent color is used for interactive elements, highlights, and progress indicators throughout the app.

### Font Size

Four preset sizes to adjust the overall text size:

| Preset          | Description                                |
| --------------- | ------------------------------------------ |
| **Small**       | Compact — more content visible at once     |
| **Medium**      | Default — balanced readability and density |
| **Large**       | Increased size for easier reading          |
| **Extra Large** | Maximum size for accessibility             |

### Sidebar Width

Control the width of the sidebar independently from the font size. Drag the sidebar's right edge in the main UI, or use the Appearance panel to set a precise value.

---

## Notifications

The app provides two levels of notifications to keep you informed about job progress.

### In-App Notification Toasts

When events occur during processing, a **toast notification** slides in from the top-right corner of the window. It auto-dismisses after 10 seconds. Click on the toast to dismiss it immediately.

You'll see toasts for:

| Event                 | Example Message                                                      |
| --------------------- | -------------------------------------------------------------------- |
| **Upload started**    | "Sprint Review — transcription started"                              |
| **Job started**       | "Job a1b2c3d4 started — transcription processing"                    |
| **Pipeline paused**   | "Sprint Review — speaker identification needed"                      |
| **Job complete**      | "Sprint Review — transcription complete"                             |
| **Job failed**        | "Sprint Review — Processing failed — check the Logs tab for details" |
| **Cancelled**         | "Processing cancelled"                                               |
| **Config incomplete** | "Config incomplete: missing DEEPSEEK_API_KEY"                        |
| **API error**         | "Failed to apply labels: ..."                                        |

### OS-Level Notifications

For important events, the app also sends a **native OS notification** that appears even if the app window is minimized or in the background:

| Event                                     | Title                        | Body                                                         | Icon                        |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------------ | --------------------------- |
| **Job started**                           | Transcription Started        | "Sprint Review"                                              | Blue play ▶ (Windows)       |
| **Speaker labels needed**                 | Speaker Labels Needed        | "Sprint Review — click to identify speakers"                 | Yellow pause ⏸ (Windows)    |
| **Raw transcript review needed** (Gate 1) | Raw Transcript Review Needed | "Sprint Review — click to review and approve the transcript" | Yellow pause ⏸ (Windows)    |
| **Delivery review needed** (Gate 2)       | Delivery Review Needed       | "Sprint Review — click to review and approve delivery"       | Yellow pause ⏸ (Windows)    |
| **Job complete**                          | Transcription Complete       | "Sprint Review — click to view results"                      | Green checkmark ✓ (Windows) |
| **Job failed**                            | Transcription Failed         | "Sprint Review — [error message]"                            | Red X ✗ (Windows)           |
| **Job cancelled**                         | Transcription Cancelled      | "Sprint Review — [reason]"                                   | Red X ✗ (Windows)           |

- **Clicking** an OS notification brings the app window to the front and navigates to the relevant view.
- **Icons** are drawn programmatically — shown on Windows, omitted on macOS (macOS uses the app icon).
- **Sound** plays by default on both platforms (no configuration required).

---

## Server Status Banner

When one or more backend services (Python, Bridge, Agent, Diarization model, or Ollama) are not running, a **Server Status popover** appears over the current view:

- **20-second countdown** — a circular progress indicator counts down before automatically checking the servers
- **Per-service status** — shows which services are up (🟢) and which are down (🔴)
- **Check Now button** — manually trigger a service check at any time
- **Collapsible Developer section** — shows detailed service status with individual restart buttons:

  | Service     | Restart Action                                                          |
  | ----------- | ----------------------------------------------------------------------- |
  | Python      | Restart the Python backend process                                      |
  | Bridge      | Restart the bridge server                                               |
  | Agent       | Restart the agent runner                                                |
  | Diarization | Opens Config to set up the Hugging Face token                           |
  | Ollama      | **Start Ollama** button (appears if Ollama is required but not running) |

- **Restart All button** — restarts all services at once
- The popover **closes automatically** once all services are back online (with a brief green confirmation)

If the popover is dismissed while services are still down, it will reappear on the next status check failure.

---

## Troubleshooting

### App Won't Start

1. Make sure your computer meets the requirements
2. Try reinstalling the app
3. Check that no other instance is running
4. If the app launches but shows a blank screen, open **Dev Tools** (🛠️ in sidebar) and check the **Live Logs** tab for startup errors

### Upload Fails

| Error                                    | Solution                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Unsupported format"                     | Convert your audio to WAV or MP3 and try again                                                                                                                                                                                                                           |
| "File too large"                         | Files must be under 500 MB                                                                                                                                                                                                                                               |
| "A transcription job is already running" | Wait for the current job to finish, or cancel it from the pipeline stepper                                                                                                                                                                                               |
| "Config incomplete"                      | Open **Config** (⚙️ in sidebar) and set your DeepSeek API Key and Hugging Face Token                                                                                                                                                                                     |
| Attendee conflict warning                | A warning appeared during attendee entry (upload form) or a conflict dialog appeared during speaker labeling. See the [Matching Voices](#4-%EF%B8%8F-matching-voices) section for how to resolve name/email conflicts and what **Overwrite** vs **Keep Existing** means. |

### Processing Stalls

1. Check the status bar — are all service dots green?
2. If a service is red:
   - Click the ▶ button next to the service name to restart it, or
   - A **Server Status popover** will appear with restart options
3. Long meetings can take 30+ minutes to process — be patient
4. Check the **Mini Live Log** under the pipeline stepper for real-time status messages
5. If the pipeline is paused (awaiting review), check for a **notification toast** at the top of the screen or an **OS notification** in your notification center

### Speaker Not Identified

- Enter attendee names and emails before uploading
- If the number of speakers doesn't match attendees, the app will pause and show a speaker labeling modal
- Each speaker must be assigned a name and valid email address
- Once labeled, the app remembers voices for future meetings
- If no Hugging Face token is configured, a yellow warning banner appears: "Speaker identification unavailable"

### "Backend services are down"

1. Wait a moment — the app may be starting up. A **Server Status popover** will appear with a 20-second countdown before auto-checking.
2. Click **Check Now** in the popover to trigger an immediate check.
3. If specific services are down, click their **Restart** buttons in the popover's developer section.
4. Restart the app.
5. Check **Dev Tools** (🛠️ in sidebar) → **Live Logs** tab for error details.

### Pipeline Fails with Error

- The pipeline stepper turns red and shows a detailed error message in the error box
- Click **New Job** below the error to start a fresh upload
- Check the **Results Viewer → Developer → Logs** tab for the full pipeline trace
- Common issues:
  - **Audio file corrupted** — try re-encoding the file
  - **API key invalid** — check your DeepSeek API key in Config
  - **Hugging Face token expired** — refresh your token at huggingface.co/settings/tokens
  - **Ollama not running** — check Ollama server status in Config's LLM Provider section

### Gate Review Not Appearing

- If you expected an approval gate to appear but the pipeline continued without pausing:
  - Open **Config** (⚙️ in sidebar) → **Pipeline** section
  - Verify that **Raw Transcript Review (Gate 1)** and/or **Delivery Review (Gate 2)** are enabled
  - These settings only take effect for NEW jobs — already-running jobs use the settings that were active when they started

### Screenshot Tests Not Running

If the Dev Panel Testing tab shows an error when you click "Run Tests":

- Make sure the app is built: run `cd electron && npm run build`
- Verify backend services are running (Python :5001, Bridge :5010)
- Check that the audio file path points to an existing file
- Look in **Dev Tools → Live Logs** tab for "[testing]" prefixed messages

### How to Get Help

- Check **Dev Tools → Live Logs** or **Log Files** tab for error messages
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
