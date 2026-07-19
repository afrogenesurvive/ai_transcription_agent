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
- **System prompt** → `agent-config/system-prompt.md` → editable without touching code
- **Sanitization** → `agent-runner/sanitize.js` → Tier 1 mandatory + Tier 2 optional

## Memory Systems

- **Semantic**: ChromaDB at `storage/chroma/` — vector search over past meetings
- **Ephemeral**: SQLite at `storage/ephemeral_memory.db` — action items, contacts, budgets
- **Voiceprints**: SQLite at `storage/voiceprints.db` — speaker embeddings

## Configuration (Environment Variables)

| Variable                         | Default  | Description                                                                                                                                                                   |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHISPER_MODEL_SIZE`             | `medium` | Whisper model size (tiny/base/small/medium/large)                                                                                                                             |
| `WHISPER_INITIAL_PROMPT_ENABLED` | `false`  | Toggle to pass an initial prompt to Whisper for context priming                                                                                                               |
| `WHISPER_INITIAL_PROMPT`         | `""`     | Text prompt sent to Whisper before transcription (e.g. "This is a technical discussion about software architecture"). Helps bias the model toward domain-specific vocabulary. |
| `DEVICE`                         | `auto`   | Compute device: `auto`, `cpu`, `cuda`, `mps`                                                                                                                                  |
| `PLATFORM`                       | `auto`   | Whisper backend: `auto`, `mac`, `windows`, `linux`                                                                                                                            |
| `GATE_RAW_REVIEW_ENABLED`        | `false`  | Pause after ASR+alignment for raw transcript review/editing before LLM processing                                                                                             |
| `GATE_DELIVERY_REVIEW_ENABLED`   | `false`  | Pause after LLM analysis for transcript/summary/analysis review before memory save + delivery                                                                                 |

Set these in a `.env` file in `python-backend/` or export them in your shell.

## Useful Commands

- `npm run transcribe:setup` — full first-time setup (venv, pip, npm, platform Whisper)
- `npm run transcribe:backend` — start Python backend only
- `npm run electron:dev` — Electron desktop UI (requires backend running)
