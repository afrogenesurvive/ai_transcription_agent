/** Types shared between components */

export interface TranscriptionSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface JobStatus {
  job_id: string;
  status: string;
  progress: number;
  error?: string;
  unknown_speakers?: unknown[];
  transcript?: TranscriptionSegment[];
  summary?: {
    executive_summary?: string;
    key_decisions?: string[];
    discussion_points?: string[];
    action_items?: { description: string; assignee?: string; deadline?: string }[];
  };
  metadata?: {
    title?: string;
    attendees?: string[];
    event_type?: string;
  };
}

export interface LogEntry {
  timestamp: number;
  source: "python" | "bridge" | "agent" | "main";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface AnalysisData {
  topics?: string[];
  sentiment?: string;
  key_entities?: string[];
  effectiveness?: string;
  follow_ups?: string[];
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
  source: "primary" | "mirror";
}

export interface ConfigValueSource {
  value: string;
  source: "user_config" | "env_file" | "default";
}

export interface StorageUsage {
  logs: { bytes: number; human: string; path?: string | null };
  history: { bytes: number; human: string; job_count: number; path?: string | null };
  chroma: { bytes: number; human: string; path?: string | null };
  databases: { bytes: number; human: string; path?: string | null };
  system: { bytes: number; human: string; path?: string | null };
  total: { bytes: number; human: string };
  error?: string;
}

export interface ElectronAPI {
  selectAudioFile: () => Promise<string | null>;
  getBackendStatus: () => Promise<{ python: boolean; bridge: boolean; agent: boolean }>;
  checkServers: () => Promise<{ python: boolean; bridge: boolean; agent: boolean }>;
  stopServices: () => Promise<{ success: boolean }>;
  restartServices: () => Promise<{ success: boolean }>;
  stopService: (service: string) => Promise<{ success: boolean }>;
  restartService: (service: string) => Promise<{ success: boolean }>;
  getAppVersion: () => Promise<string>;
  getActiveJobs: () => Promise<Array<{ job_id: string; status: string; progress: number; title: string }>>;
  onNotification: (cb: (msg: string) => void) => () => void;
  getLogs: () => Promise<LogEntry[]>;
  clearLogs: () => Promise<{ success: boolean }>;
  onLog: (cb: (entry: LogEntry) => void) => () => void;
  getConfig: () => Promise<Record<string, string>>;
  saveConfig: (values: Record<string, string>) => Promise<Record<string, string>>;
  checkConfig: () => Promise<{ ok: boolean; missing: string[] }>;
  getConfigWithSources: () => Promise<Record<string, ConfigValueSource>>;
  getAgentConfig: () => Promise<{ tools?: any; pipeline?: any; systemPrompt?: string; error?: string }>;
  saveAgentConfig: (config: { tools?: any; pipeline?: any; systemPrompt?: string }) => Promise<{ success?: boolean; error?: string }>;
  restartAgent: () => Promise<{ success?: boolean; error?: string }>;
  listLogFiles: () => Promise<LogFileInfo[]>;
  readLogFile: (filePath: string, maxLines?: number) => Promise<string[]>;
  getLogPaths: () => Promise<{ primary: string | null; mirror: string | null }>;
  getStorageUsage: () => Promise<StorageUsage>;
  getPerformanceMetrics: () => Promise<{
    electron: Array<{ type: string; pid: number; cpu: number | null; memory: number | null; peakMemory: number | null }>;
    children: Array<{ service: string; pid: number; cpu: number; memory: number; elapsed: number }>;
  }>;
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
  platform: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
