/**
 * Shared LLM provider metadata — single source of truth for provider labels,
 * colors, badges, and capability flags used across the renderer (DevPanel,
 * ResultsViewer, StatusBar, HistoryPanel, ConfigPanel).
 */

export interface LlmProviderMeta {
  id: string;
  label: string;
  color: string;
  isLocal: boolean;
  /** Whether this provider exposes a public usage/credit balance endpoint. */
  supportsBalance: boolean;
  /** Short description for tooltips / badges. */
  description: string;
}

export const LLM_PROVIDERS: Record<string, LlmProviderMeta> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    color: "#3fb950",
    isLocal: false,
    supportsBalance: true,
    description: "Cloud API",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    color: "#58a6ff",
    isLocal: false,
    supportsBalance: false,
    description: "Cloud API — no public balance endpoint",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    color: "#f0883e",
    isLocal: false,
    supportsBalance: false,
    description: "Cloud API — no public balance endpoint",
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    color: "#bc8cff",
    isLocal: true,
    supportsBalance: false,
    description: "Local — no cost",
  },
  unknown: {
    id: "unknown",
    label: "Unknown",
    color: "#8b949e",
    isLocal: false,
    supportsBalance: false,
    description: "",
  },
};

/** Provider ids in a stable order (for tabs / filters). */
export const LLM_PROVIDER_IDS = ["deepseek", "openai", "anthropic", "ollama"] as const;

/** Resolve a raw provider string to its metadata (unknown values → grey "Unknown"). */
export function providerMeta(id: string | null | undefined): LlmProviderMeta {
  const s = (id || "").toLowerCase();
  return LLM_PROVIDERS[s] || LLM_PROVIDERS.unknown;
}

export function providerLabel(id: string | null | undefined): string {
  return providerMeta(id).label;
}

export function providerColor(id: string | null | undefined): string {
  return providerMeta(id).color;
}

export function providerSupportsBalance(id: string | null | undefined): boolean {
  return providerMeta(id).supportsBalance;
}
