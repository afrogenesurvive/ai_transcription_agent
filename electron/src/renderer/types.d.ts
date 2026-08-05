/** Types shared between components */

/** A single step in the pipeline checklist — orderable, togglable, editable */
export interface PipelineStep {
  id: string;
  toolName: string;
  label: string;
  description: string;
  systemPromptTemplate: string;
  hintTemplate: string;
  enabled: boolean;
  isTerminal: boolean;
}

export interface TranscriptionSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

/** A summary action item. description_html holds optional rich-text markup. */
export interface ActionItem {
  description: string;
  description_html?: string;
  assignee?: string;
  deadline?: string;
}

/**
 * Structured meeting summary. Each text field may have a parallel `_html`
 * twin holding Tiptap-generated rich text; the plain fields remain
 * authoritative for downstream consumers (semantic memory, exports, etc.).
 */
export interface SummaryData {
  executive_summary?: string;
  executive_summary_html?: string;
  key_decisions?: string[];
  key_decisions_html?: string[];
  discussion_points?: string[];
  discussion_points_html?: string[];
  action_items?: ActionItem[];
}

export interface JobStatus {
  job_id: string;
  status: string;
  progress: number;
  error?: string;
  unknown_speakers?: unknown[];
  transcript?: TranscriptionSegment[];
  summary?: SummaryData;
  metadata?: {
    title?: string;
    originalFilename?: string;
    attendees?: string[];
    attendeeEmails?: string[];
    event_type?: string;
  };
}

export interface LogEntry {
  timestamp: number;
  source: "python" | "bridge" | "agent" | "main";
  subSource?: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  stageProgress?: { jobId?: string; stage: "diarization" | "transcription"; percent: number };
}

/** A group of consecutive log entries sharing the same source/subsource/level */
export interface LogGroupEntry {
  timestamp: number;
  source: string;
  subSource?: string;
  level: string;
  lines: Array<{
    timestamp: number;
    message: string;
  }>;
}

export interface AnalysisData {
  topics?: string[];
  sentiment?: string;
  sentiment_html?: string;
  key_entities?: string[];
  effectiveness?: string;
  effectiveness_html?: string;
  follow_ups?: string[];
  follow_ups_html?: string[];
}

export interface MemorySearchResult {
  id: string;
  score: number;
  document: string;
  metadata: { title?: string; job_id?: string; type?: string };
}

export interface LogFileInfo {
  path: string;
  name: string;
  size: number;
  mtime: string;
  source: "primary" | "mirror" | "job";
}

export interface ConfigValueSource {
  value: string;
  source: "user_config" | "default" | "environment";
}

export interface StorageUsage {
  logs: { bytes: number; human: string; path?: string | null };
  history: { bytes: number; human: string; job_count: number; path?: string | null };
  chroma: { bytes: number; human: string; path?: string | null };
  databases: { bytes: number; human: string; path?: string | null };
  system: { bytes: number; human: string; path?: string | null };
  ollama: { bytes: number; human: string; path?: string | null };
  total: { bytes: number; human: string };
  error?: string;
}

export interface ElectronAPI {
  selectAudioFile: () => Promise<string | null>;
  getBackendStatus: () => Promise<{ python: boolean; bridge: boolean; agent: boolean; diarizationAvailable: boolean | null; diarizationError: string | null }>;
  checkServers: () => Promise<{ python: boolean; bridge: boolean; agent: boolean; diarizationAvailable: boolean | null; diarizationError: string | null }>;
  stopServices: () => Promise<{ success: boolean }>;
  restartServices: () => Promise<{ success: boolean }>;
  closeApp: () => Promise<{ success: boolean }>;
  confirmQuit: (message: string) => Promise<{ success: boolean }>;
  quitApp: () => Promise<{ success: boolean }>;
  stopService: (service: string) => Promise<{ success: boolean }>;
  restartService: (service: string) => Promise<{ success: boolean }>;
  getAppVersion: () => Promise<string>;
  getAppName: () => Promise<string>;
  getReadme: () => Promise<string>;
  getGuide: () => Promise<string>;
  getDoc: (filename: string) => Promise<string>;
  getActiveJobs: () => Promise<Array<{ job_id: string; status: string; progress: number; title: string }>>;
  getRunningBotJobs: () => Promise<Array<{ job_id: string; status: string }>>;
  onNotification: (cb: (msg: string) => void) => () => void;
  getLogs: () => Promise<LogEntry[]>;
  clearLogs: () => Promise<{ success: boolean }>;
  onLog: (cb: (entry: LogEntry) => void) => () => void;
  onJobProgress: (cb: (payload: { jobId?: string; stage: "diarization" | "transcription"; percent: number; timestamp?: number }) => void) => () => void;
  getConfig: () => Promise<Record<string, string>>;
  saveConfig: (values: Record<string, string>) => Promise<Record<string, string>>;
  checkConfig: () => Promise<{ ok: boolean; missing: string[] }>;
  getConfigWithSources: () => Promise<Record<string, ConfigValueSource>>;
  exportConfig: () => Promise<{ success: boolean; filePath?: string; error?: string; cancelled?: boolean; warnings?: string[] }>;
  clearConfig: () => Promise<{ success: boolean; error?: string; blocked?: boolean }>;
  importConfig: () => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
    cancelled?: boolean;
    blocked?: boolean;
    agentConfigImported?: boolean;
    defaultsImported?: boolean;
    userDefaultsImported?: boolean;
  }>;
  getDefaultUserConfig: () => Promise<{ success: boolean; defaults: Record<string, string>; error?: string }>;
  restoreDefaultUserConfig: () => Promise<{ success: boolean; error?: string; blocked?: boolean }>;
  getAgentConfig: () => Promise<{ tools?: any; pipeline?: any; systemPrompt?: string; error?: string }>;
  saveAgentConfig: (config: { tools?: any; pipeline?: any; systemPrompt?: string }) => Promise<{ success?: boolean; error?: string }>;
  restartAgent: () => Promise<{ success?: boolean; error?: string }>;
  getDefaultAgentConfig: () => Promise<{ tools?: any; pipeline?: any; systemPrompt?: string; error?: string }>;
  restoreDefaultAgentConfig: () => Promise<{ success?: boolean; restored?: string[]; error?: string }>;

  // ── UI State (userData/ui-state.json — renderer is the single writer) ──
  getUiState: () => Promise<Record<string, any>>;
  saveUiState: (state: Record<string, any>) => Promise<boolean>;

  // ── File path (persist the New-form's selected audio file across restarts) ──
  getPathForFile: (file: File) => string;

  listJobLogFiles: () => Promise<LogFileInfo[]>;
  readJobLogFile: (jobId: string, maxLines?: number) => Promise<string[]>;
  getStorageUsage: () => Promise<StorageUsage>;
  getPerformanceMetrics: () => Promise<{
    electron: Array<{ type: string; pid: number; cpu: number | null; memory: number | null; peakMemory: number | null }>;
    children: Array<{ service: string; pid: number; cpu: number; memory: number; elapsed: number }>;
  }>;

  // ── Per-Job & Aggregate Performance ──
  getPerJobPerformance: (
    jobId: string,
  ) => Promise<Array<{ timestamp: number; cpu: number; memoryBytes: number; label: string; stage: string | null }>>;
  getAggregatePerformance: () => Promise<
    Array<{
      jobId: string;
      samples: Array<{ timestamp: number; cpu: number; memoryBytes: number; label: string; stage: string | null }>;
    }>
  >;
  // ── Native Notifications ──
  showNotification: (opts: {
    title: string;
    body: string;
    clickPayload?: Record<string, unknown>;
    type?: "info" | "success" | "error" | "started" | "paused";
    silent?: boolean;
    subtitle?: string;
  }) => Promise<void>;
  onNotificationClick: (cb: (payload: Record<string, unknown>) => void) => () => void;
  onJobStarted: (cb: (payload: { jobId: string; title?: string }) => void) => () => void;

  // ── Tray / Menu Bar ──
  toggleTray: () => Promise<{ visible: boolean }>;
  getTrayStatus: () => Promise<{ visible: boolean }>;

  // ── Ollama Health & Server Management ──
  checkOllamaHealth: () => Promise<{ healthy: boolean }>;
  startOllamaServer: () => Promise<{ success: boolean; error?: string }>;
  listOllamaModels: () => Promise<{
    models: Array<{ name: string; size: number; modified_at: string }>;
    error: string | null;
    wasStarted?: boolean;
  }>;
  pullOllamaModel: (modelName: string) => Promise<{ success: boolean; error: string | null }>;
  stopOllamaServer: () => Promise<{ success: boolean }>;

  // ── Auto-Update ──
  getUpdateStatus: () => Promise<{
    mode: "dev" | "packaged";
    enabled: boolean;
    lastCheck: string | null;
    lastUpdate: string | null;
    updateAvailable: string | null;
    checking: boolean;
    currentVersion: string;
    error: string | null;
    downloadProgress: number | null;
    updateDownloaded: boolean;
  }>;
  checkForUpdates: () => Promise<{ updateAvailable: boolean; details: string | null; error: string | null }>;
  setAutoUpdateEnabled: (enabled: boolean) => Promise<{ success: boolean }>;
  downloadUpdate: () => Promise<{ success: boolean; error: string | null }>;
  installUpdate: () => Promise<{ success: boolean }>;

  // ── DeepSeek API Credit Balance ──
  checkDeepSeekBalance: () => Promise<{
    available: boolean;
    balance: string | null;
    error: string | null;
  }>;

  // ── Aggregate Token Usage ──
  getAggregateUsage: () => Promise<{
    jobs: Array<{
      job_id: string;
      title: string;
      provider: string;
      model: string;
      step_count: number;
      totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      saved_at: string;
    }>;
    totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    job_count: number;
    error?: string;
  }>;

  // ── Shell & File system ──
  openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  fileExists: (filePath: string) => Promise<boolean>;
  runInTerminal: (params: { command: string; cwd?: string }) => Promise<{ success: boolean; error?: string }>;

  // ── Playwright Testing ──
  checkDevMode: () => Promise<{ devMode: boolean }>;
  runPlaywrightTests: (vars: Record<string, string>) => Promise<{ exitCode: number; output: string }>;
  onPlaywrightOutput: (callback: (text: string) => void) => () => void;
  checkPlaywrightBuild: () => Promise<{ exists: boolean; builtAt: string | null }>;

  // ── Bot Testing (Backend) ──
  readBotScript: () => Promise<string>;
  saveBotScript: (content: string) => Promise<{ success: boolean; error?: string }>;
  runBotScript: () => Promise<{ exitCode: number; output: string }>;
  stopBotScript: () => Promise<{ success: boolean; message?: string }>;
  readBotTestLog: () => Promise<string>;
  onBotScriptOutput: (callback: (text: string) => void) => () => void;
  checkNodeAvailable: () => Promise<{ available: boolean; path: string | null }>;

  // ── Export (PDF / Word) ──
  exportToPdf: (params: { html: string; defaultName?: string }) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
    cancelled?: boolean;
  }>;
  exportToWord: (params: { html: string; defaultName?: string }) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
    cancelled?: boolean;
  }>;

  // ── Tunnel (Cloudflare) ──
  startTunnel: () => Promise<{ success: boolean; error?: string; url?: string }>;
  stopTunnel: () => Promise<{ success: boolean; error?: string }>;
  getTunnelStatus: () => Promise<{ running: boolean; url: string | null; error: string | null }>;

  platform: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
