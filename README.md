# AI Meeting Transcription Agent

A self-contained, fully autonomous meeting transcription service with speaker diarization, LLM-based summarization, and multi-channel delivery (email, Trello, Drive).

## Architecture

```
ai_transcription_agent/
├── python-backend/        FastAPI server (:5001)
│   ├── main.py           Routes + pipeline orchestration
│   ├── transcription.py  Platform-aware ASR + diarization
│   ├── voiceprint.py     Speaker embedding storage + matching
│   ├── semantic_memory.py  ChromaDB vector store (semantic search)
│   ├── ephemeral_memory.py SQLite structured memory (actions, contacts, budgets)
│   ├── agent_bridge.py   Queue writer + trigger file
│   ├── upload.py         Audio validation + standardization
│   ├── config.py         Environment-based configuration
│   └── models.py         Pydantic request/response schemas
│
├── bridge-server/        Node.js REST bridge (:5010)
│   └── index.js          Proxies tool calls to Python backend
│
├── agent-runner/         Standalone LLM agent
│   ├── index.js          Main loop + fs.watch trigger system
│   ├── model-client.js   DeepSeek V4 / Ollama client
│   ├── tool-executor.js  Executes tools via bridge or APIs
│   ├── poller.js         Queue reader
│   └── logger.js         Structured action logging
│
├── docs/                 Architecture docs
├── queue/                Runtime: job event queue files
└── storage/              Runtime: audio, voiceprints, transcripts, vector index, memory DB
    ├── <job_id>/         Per-job artifacts
    ├── chroma/           ChromaDB vector index (semantic memory)
    ├── ephemeral_memory.db  SQLite (action items, contacts, budgets, decisions)
    └── voiceprints.db    SQLite (speaker embeddings)
```

### Push-Trigger Flow

```
Python Backend              Agent Runner
─────────────               ────────────
1. Diarization + ASR done
2. Writes event to queue/transcription.jsonl
3. Touches queue/.transcription-trigger
                             4. fs.watch fires
                             5. Reads queue, sends context to LLM
                             6. LLM chooses tool (refine, summarize, deliver)
                             7. Executes via bridge-server (:5010)
                             8. Marks event cleared
```

**No polling** — the runner sits idle until the trigger file changes.

## Quick Start

### 1. Setup

```bash
npm run transcribe:setup
```

### 2. Start

All three services at once:

```bash
npm run transcribe:all
```

Or individually (three terminals):

```bash
npm run transcribe:backend   # Python ML pipeline on :5001
npm run transcribe:bridge    # Bridge server on :5010
npm run transcribe:runner    # Agent runner (interactive prompt)
```

## Environment Variables

| Variable              | Default                     | Description            |
| --------------------- | --------------------------- | ---------------------- |
| `LLM_PROVIDER`        | `deepseek`                  | `deepseek` or `ollama` |
| `DEEPSEEK_API_KEY`    | —                           | Required for DeepSeek  |
| `OLLAMA_BASE_URL`     | `http://127.0.0.1:11434/v1` | Ollama endpoint        |
| `OLLAMA_MODEL`        | `llama3.1:8b`               | Ollama model           |
| `TRANSCRIPTION_PORT`  | `5001`                      | Python backend port    |
| `BRIDGE_PORT`         | `5010`                      | Bridge server port     |
| `WHISPER_MODEL_SIZE`  | `medium`                    | Whisper model size     |
| `GMAIL_CLIENT_ID`     | —                           | For email delivery     |
| `GMAIL_REFRESH_TOKEN` | —                           | For email delivery     |
| `TRELLO_KEY`          | —                           | For Trello delivery    |
| `TRELLO_TOKEN`        | —                           | For Trello delivery    |

## Pipeline Stages

| Stage            | What Happens                        | Output                                      |
| ---------------- | ----------------------------------- | ------------------------------------------- |
| Upload           | Validate + standardize audio        | 16kHz mono WAV                              |
| Diarization      | Pyannote identifies speakers        | Speaker segments                            |
| Voiceprint Match | Compare against stored embeddings   | Known/unknown speakers                      |
| Transcription    | Whisper/MLX/faster-whisper ASR      | Word-level timestamps                       |
| Alignment        | Map words to speaker segments       | Labeled transcript                          |
| Agent Refine     | LLM redacts PII, cleans formatting  | Clean transcript                            |
| Agent Summarize  | LLM extracts summary + action items | Summary JSON                                |
| Memory Save      | Embed + store in ChromaDB + SQLite  | Searchable vector index + structured tables |
| Delivery         | Email / Trello / Drive              | Sent via Gmail API / Trello API / Drive API |

## Agent Runner Commands

At the `runner>` prompt:

```
status   — Show pending queue items
trigger  — Manually touch trigger file to process now
stop     — Shut down the runner
```

## Memory Systems

### Semantic Memory (Vector Search)

- **Engine**: ChromaDB — persisted at `storage/chroma/`
- **Embedding**: `sentence-transformers/all-MiniLM-L6-v2` (local, ~80MB, no API key)
- **What's stored**: Meeting title + summary + key decisions + transcript
- **How to search**: Agent calls `transcribe_search_memory(query="budget Q4")`
- **Auto-save**: Agent calls `transcribe_save_context` after summarization

### Ephemeral Memory (Structured Data)

- **Engine**: SQLite — persisted at `storage/ephemeral_memory.db`
- **Tables**: `action_items`, `contacts`, `budgets`, `decisions`, `notes`
- **How to save**: Agent calls `transcribe_save_ephemeral(table, data)`
- **How to query**: Agent calls `transcribe_query_ephemeral(table, query)`

## Dependencies

- **Python**: fastapi, uvicorn, pyannote.audio, whisper, torch, numpy, chromadb, sentence-transformers
- **Node.js**: openai (for DeepSeek/Ollama SDK), googleapis, google-auth-library, dotenv

### Platform-Specific

- **macOS (Apple Silicon)**: `pip install mlx-whisper` for Neural Engine acceleration
- **Windows (NVIDIA GPU)**: `pip install faster-whisper` for CUDA acceleration
- **Linux**: Standard Whisper (PyTorch) or faster-whisper with CUDA

The setup script (`npm run transcribe:setup`) auto-detects your platform and installs the correct Whisper variant.
