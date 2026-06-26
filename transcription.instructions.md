# Transcription Agent — Workspace Guide

Three independent services run in this workspace for the transcription pipeline:

## Service Layout

| Service        | Directory         | Port    | Tech                         | Start command                |
| -------------- | ----------------- | ------- | ---------------------------- | ---------------------------- |
| Python Backend | `python-backend/` | `:5001` | FastAPI + Pyannote + Whisper | `npm run transcribe:backend` |
| Bridge Server  | `bridge-server/`  | `:5010` | Node.js REST proxy           | `npm run transcribe:bridge`  |
| Agent Runner   | `agent-runner/`   | —       | Node.js (fs.watch + LLM)     | `npm run transcribe:runner`  |

All three together: `npm run transcribe:all`

## Key Files

- **ML pipeline** → `python-backend/main.py` → `_run_pipeline()` triggers diarization → ASR → voiceprint matching
- **Agent loop** → `agent-runner/index.js` → `processEvent()` reads queue, calls LLM, executes tool
- **Tool handlers** → `agent-runner/tool-executor.js` → bridge calls + Gmail/Trello/Drive direct APIs
- **LLM client** → `agent-runner/model-client.js` → DeepSeek V4 or Ollama
- **System prompt** → `agent-runner/system-prompt.md` → editable without touching code
- **Sanitization** → `agent-runner/sanitize.js` → Tier 1 mandatory + Tier 2 optional

## Memory Systems

- **Semantic**: ChromaDB at `storage/chroma/` — vector search over past meetings
- **Ephemeral**: SQLite at `storage/ephemeral_memory.db` — action items, contacts, budgets
- **Voiceprints**: SQLite at `storage/voiceprints.db` — speaker embeddings

## Useful Commands

- `npm run transcribe:setup` — full first-time setup (venv, pip, npm, platform Whisper)
- `npm run electron:dev` — Electron desktop UI (requires backend running)
