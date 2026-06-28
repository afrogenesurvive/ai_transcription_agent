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

export interface MemorySearchResult {
  id: string;
  score: number;
  document: string;
  metadata: { title?: string; job_id?: string; type?: string };
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
  onNotification: (cb: (msg: string) => void) => () => void;
  platform: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
