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

The app has a simple layout:

```
┌─────────────────────────────────────────────────────────┐
│  📁 Upload Panel          │  📝 Results Viewer          │
│  (drag audio here,        │  (shows transcript,         │
│   set title, add          │   summary, analysis,        │
│   attendees)              │   audio player)             │
├───────────────────────────┤                             │
│  📊 Progress Panel        │                             │
│  (shows pipeline status)  │                             │
├───────────────────────────┴─────────────────────────────┤
│  Status Bar  ⚙️  🖥️  💾  ℹ️                            │
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

- Audio clips for each detected speaker
- Name input fields
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

When processing is complete, the results appear in a tabbed viewer:

### 📊 Pipeline Tab

Shows a summary of all pipeline stages with checkmarks for completed steps.

### 🎧 Audio Tab

An audio player lets you listen to the original recording.

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
- **Action Items** — tasks assigned to people, with deadlines if mentioned
- Each section is collapsible

### 📊 Analysis Tab

AI-generated analysis including:

- **Topics** — main subjects discussed
- **Sentiment** — overall tone of the meeting
- **Key Entities** — names, dates, amounts mentioned
- **Meeting Effectiveness** — how productive the meeting was
- **Follow-ups** — items that need future discussion

### 📄 Raw Tab

The unrefined transcript text (before filler-word removal and PII redaction).

### 🪙 Tokens Tab

Shows how much AI processing was used (token count per pipeline step). Useful if you're on a paid API plan.

### ⚡ Performance Tab

Technical performance metrics showing processing times.

### 📬 Delivery Tab

Shows delivery status if you configured email, Drive, or Trello.

### 📋 Logs Tab

Technical log files for troubleshooting.

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

**Whisper Model Size** — affects transcription accuracy vs. speed:

- `medium` (default) — good balance
- `large` — most accurate but slower

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

For advanced users: customize the AI pipeline steps, system prompt, and tool definitions.

### Testing Tab (in Settings)

Configure variables for the Playwright screenshot tests:

| Field                    | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| **Audio File Path**      | Absolute path to an audio file (MP3/WAV) used by screenshot tests |
| **Test Title Template**  | Meeting title template (`{autoNum}` auto-increments)              |
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

The Testing tab lets you:

1. **Edit test variables** — audio file path, title template, default speaker name
2. **Run Tests** — launches Playwright with the configured variables
3. **View real-time output** — test output streams in as it runs
4. **See pass/fail status** — exit code and result displayed after completion

Variables are saved to `config.json` and persist across app restarts.

Screenshots are saved to **timestamped subdirectories** under `docs/screenshots/` (e.g. `docs/screenshots/2026-07-14/`). After each run, the images are copied to the root `docs/screenshots/` directory so the user guide always reflects the latest run. Prior runs remain accessible in their date-stamped folders.

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
